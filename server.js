require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const QRCode = require('qrcode');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const { getDb } = require('./firebase');
const { restoreSessionFromFirestore, backupSessionToFirestore } = require('./sessionSync');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 4000;
const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');
if (!fs.existsSync(AUTH_DIR)) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

// Bot State
let sock = null;
let connectionStatus = 'DISCONNECTED'; // 'DISCONNECTED' | 'CONNECTING' | 'QR_READY' | 'CONNECTED'
let latestQrDataUrl = null;
let botPhoneNumber = null;
let isConnecting = false;
let currentSocketId = 0;
let reconnectTimer = null;

// Procurement 22-Step Workflow State
const pendingProcurementPromptByPhone = new Map();
const WORKFLOW_STEPS = [
  { step: 1, text: "Suppliers ලාට Quotations යැව්වාද?", title: "Send Quotations to Suppliers", category: "Tendering" },
  { step: 2, text: "Quotations Open කළාද?", title: "Open Quotations", category: "Tendering" },
  { step: 3, text: "Quotations Schedule කළාද?", title: "Schedule Quotations", category: "Tendering" },
  { step: 4, text: "File එක Evaluations වලට Out කළාද?", title: "File Out for Evaluation (TEC)", category: "Tendering" },
  { step: 5, text: "File එක CO Signature එකට දැම්මාද?", title: "File to CO for Signature", category: "Approvals" },
  { step: 6, text: "File එක Supply එකට Handover කළාද?", title: "File Handover to Supply", category: "Approvals" },
  { step: 7, text: "File එක OCL Check කළාද?", title: "File Checked by OCL", category: "Approvals" },
  { step: 8, text: "File එක Directorate එකට Send කළාද?", title: "File Sent to Directorate", category: "Approvals" },
  { step: 9, text: "File එක PMO එකට Send කළාද?", title: "File Sent to PMO", category: "Approvals" },
  { step: 10, text: "File එක LIS එකට Send කළාද?", title: "File Sent to LIS", category: "Approvals" },
  { step: 11, text: "File එක Tender Board දැම්මාද?", title: "File to Tender Board", category: "Approvals" },
  { step: 12, text: "File එක Approve කළාද?", title: "Tender Board Approval", category: "Approvals" },
  { step: 13, text: "Order Form Print කළාද?", title: "Order Form Printed", category: "Purchasing" },
  { step: 14, text: "Order Form Supplier ට Handover කළාද?", title: "Order Form Handover to Supplier", category: "Purchasing" },
  { step: 15, text: "Items Collect කළාද?", title: "Items Collected", category: "Receiving" },
  { step: 16, text: "Guard Room In කළාද?", title: "Items In through Guard Room", category: "Receiving" },
  { step: 17, text: "GRN Path එක Complete කළාද?", title: "GRN Process Completed", category: "Receiving" },
  { step: 18, text: "Items Quality Check කළාද?", title: "Items Quality Checked", category: "Receiving" },
  { step: 19, text: "Items Grp In කළාද?", title: "Items Group In (Store)", category: "Receiving" },
  { step: 20, text: "Bill එක Prepare කළාද?", title: "Bill Prepared", category: "Billing" },
  { step: 21, text: "Bill එක CO Signature එකට දැම්මාද?", title: "Bill to CO for Signature", category: "Billing" },
  { step: 22, text: "Bill එක HQ වලට Send කළාද?", title: "Bill Forwarded to HQ (Final)", category: "Billing" }
];

function destroyCurrentSocket() {
  currentSocketId++;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (sock) {
    const oldSock = sock;
    sock = null;
    try { oldSock.ev.removeAllListeners(); } catch (e) { }
    try { oldSock.ws?.close(); } catch (e) { }
    try { oldSock.end(); } catch (e) { }
  }
}

function scheduleReconnect(delayMs, force = false) {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToWhatsApp(force);
  }, delayMs);
}

// Track last alerted batch per target phone for direct interactive YES/NO replies
const activeBatchAlerts = new Map();
let pendingAlertQueue = [];

async function loadAlertQueue(db) {
  if (pendingAlertQueue.length > 0) return pendingAlertQueue;
  if (!db) return [];
  try {
    const doc = await db.collection('settings').doc('alert_queue').get();
    if (doc.exists && Array.isArray(doc.data()?.queue)) {
      pendingAlertQueue = doc.data().queue;
      return pendingAlertQueue;
    }
  } catch (err) {
    console.error('❌ Error loading alert queue from Firestore:', err.message);
  }
  return [];
}

async function saveAlertQueue(db, queue) {
  pendingAlertQueue = Array.isArray(queue) ? queue : [];
  if (!db) return;
  try {
    await db.collection('settings').doc('alert_queue').set({
      queue: pendingAlertQueue,
      updatedAt: new Date().toISOString()
    });
  } catch (err) {
    console.error('❌ Error saving alert queue to Firestore:', err.message);
  }
}

function formatDisplayDate(expiryDateVal) {
  const iso = formatDateString(expiryDateVal);
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const [y, m, d] = iso.split('-').map(Number);
  const dd = String(d).padStart(2, '0');
  const mmm = months[m - 1] || String(m).padStart(2, '0');
  return `${dd}/${mmm}/${y}`;
}

function getColorTheme(days) {
  if (days <= 3) {
    return { bar: '🟥🟥🟥🟥🟥🟥🟥🟥🟥🟥', dot: '🔴' };
  } else if (days <= 14) {
    return { bar: '🟧🟧🟧🟧🟧🟧🟧🟧🟧🟧', dot: '🟠' };
  } else if (days <= 30) {
    return { bar: '🟨🟨🟨🟨🟨🟨🟨🟨🟨🟨', dot: '🟡' };
  } else {
    return { bar: '🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩', dot: '🟢' };
  }
}

function formatRemainingDaysValue(days) {
  if (days === null || days === undefined) return '--';
  if (days < 0) return `00 (Expired ${String(Math.abs(days)).padStart(2, '0')}d ago)`;
  return String(days).padStart(2, '0');
}

function formatQueueAlertMessage(item, remainingAfterThis, isNext = false) {
  const days = item.days !== undefined ? item.days : getDaysRemaining(item.expiryDate);
  const { bar, dot } = getColorTheme(days);
  const countLabel = item.total && item.total > 1 ? ` (${item.index}/${item.total})` : '';
  const displayDate = formatDisplayDate(item.expiryDate);
  const remainingStr = formatRemainingDaysValue(days);

  const queueFooter = remainingAfterThis > 0
    ? `\n\n⏳ _(${remainingAfterThis} more item(s) waiting in queue)_`
    : '';

  return `${bar}
${dot} *E̲X̲P̲I̲R̲Y̲ A̲L̲E̲R̲T̲*${countLabel}
✓ Item – *${item.itemName}*
✓ Expiry Date – *${displayDate}*
✓ Remaining days – *${remainingStr}*
✓ Still in stock? Reply *YES* or *NO*${queueFooter}`;
}

async function dispatchNextFromQueue(db, targetNumbers, isNext = false) {
  await loadAlertQueue(db);

  while (pendingAlertQueue.length > 0) {
    const item = pendingAlertQueue[0];
    // Verify batch still exists in Firestore (in case it was deleted in the app)
    try {
      const batchDoc = await db.collection('stock_batches').doc(item.batchId).get();
      if (!batchDoc.exists) {
        console.log(`ℹ️ [Queue] Batch ${item.batchId} (${item.itemName}) no longer exists. Skipping to next...`);
        pendingAlertQueue.shift();
        continue;
      }
    } catch (e) {
      // proceed if transient read error
    }

    const remainingAfterThis = pendingAlertQueue.length - 1;
    const alertMessage = formatQueueAlertMessage(item, remainingAfterThis, isNext);

    if (connectionStatus === 'CONNECTED' && sock) {
      for (const targetPhone of targetNumbers) {
        const targetJid = `${targetPhone}@s.whatsapp.net`;
        await sock.sendMessage(targetJid, { text: alertMessage });
        console.log(`📤 [Queue Alert ${item.index}/${item.total}] Sent to +${targetPhone} for ${item.itemName} (Remaining waiting: ${remainingAfterThis})`);

        activeBatchAlerts.set(targetPhone, item);
        const knownLid = getLidForPhone(targetPhone);
        if (knownLid) {
          activeBatchAlerts.set(knownLid, item);
        }
      }

      // Mark milestone on batch document now that its alert has been dispatched
      await db.collection('stock_batches').doc(item.batchId).update({
        lastAlertSent: item.milestone,
        lastAlertDate: new Date().toISOString()
      }).catch(() => { });

      await saveAlertQueue(db, pendingAlertQueue);
      return item;
    } else {
      console.log(`⚠️ WhatsApp bot not connected. Queue item ${item.itemName} remains waiting.`);
      await saveAlertQueue(db, pendingAlertQueue);
      return null;
    }
  }

  await saveAlertQueue(db, []);
  return null;
}

/**
 * Clean phone number to E.164 international digits (e.g. 94771234567)
 */
function cleanPhoneNumber(phone) {
  if (!phone) return '';
  let cleaned = phone.replace(/[^0-9]/g, '');
  if (cleaned.startsWith('0')) {
    cleaned = '94' + cleaned.substring(1);
  }
  return cleaned;
}

/**
 * Format Days Remaining
 */
function getDaysRemaining(expiryDateVal) {
  if (!expiryDateVal) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let exp;
  if (expiryDateVal.toDate && typeof expiryDateVal.toDate === 'function') {
    exp = expiryDateVal.toDate();
  } else if (typeof expiryDateVal === 'string') {
    const parts = expiryDateVal.split('-').map(Number);
    exp = new Date(parts[0], parts[1] - 1, parts[2]);
  } else {
    exp = new Date(expiryDateVal);
  }
  exp.setHours(0, 0, 0, 0);

  const diffTime = exp.getTime() - today.getTime();
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

function formatDateString(expiryDateVal) {
  if (!expiryDateVal) return '';
  if (typeof expiryDateVal === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(expiryDateVal)) {
    return expiryDateVal;
  }
  let dateObj = expiryDateVal.toDate ? expiryDateVal.toDate() : new Date(expiryDateVal);
  return dateObj.toISOString().split('T')[0];
}

/**
 * Connect to WhatsApp using Baileys WebSockets (100% Free)
 */
async function connectToWhatsApp(force = false) {
  if (!force) {
    if (isConnecting) {
      console.log('⏳ [Baileys] Socket connection already in progress. Skipping duplicate connect call.');
      return;
    }
    if (sock && (connectionStatus === 'CONNECTED' || connectionStatus === 'QR_READY' || connectionStatus === 'CONNECTING')) {
      console.log(`ℹ️ [Baileys] Socket already active in state ${connectionStatus}. Skipping duplicate connect call.`);
      return;
    }
  }

  isConnecting = true;
  destroyCurrentSocket();
  const mySocketId = currentSocketId;
  connectionStatus = 'CONNECTING';
  latestQrDataUrl = null;

  try {
    const db = getDb();
    await restoreSessionFromFirestore(AUTH_DIR, db);
    if (mySocketId !== currentSocketId) return;

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    if (mySocketId !== currentSocketId) return;

    const { version } = await fetchLatestBaileysVersion();
    if (mySocketId !== currentSocketId) return;

    console.log(`🤖 [Baileys] Initializing WhatsApp Socket #${mySocketId} (v${version.join('.')})...`);

    const mySock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      auth: state,
      printQRInTerminal: true,
      browser: ['Ration Store Depot', 'Chrome', '1.0.0']
    });
    sock = mySock;

    mySock.ev.on('creds.update', async () => {
      if (mySocketId !== currentSocketId) return;
      await saveCreds();
      backupSessionToFirestore(AUTH_DIR, getDb());
    });

    mySock.ev.on('connection.update', async (update) => {
      if (mySocketId !== currentSocketId) return;
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const qrData = await QRCode.toDataURL(qr, { width: 340, margin: 2 });
        if (mySocketId !== currentSocketId) return;
        latestQrDataUrl = qrData;
        connectionStatus = 'QR_READY';
        isConnecting = false;
        console.log(`📲 [WhatsApp QR Ready] (Socket #${mySocketId}) Scan QR code at /qr`);
        const firestore = db || getDb();
        if (firestore) {
          firestore.collection('settings').doc('config').set({
            botStatus: 'DISCONNECTED',
            botPhoneNumber: '',
            lastStatusUpdate: new Date().toISOString()
          }, { merge: true }).catch(() => { });
        }
      }

      if (connection === 'close') {
        if (mySocketId !== currentSocketId) return;
        isConnecting = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        const isRestartRequired = statusCode === DisconnectReason.restartRequired || statusCode === 515;

        console.log(`⚠️ [WhatsApp Socket #${mySocketId} Closed] Reason: ${statusCode}. LoggedOut: ${isLoggedOut}, RestartRequired: ${isRestartRequired}`);

        // Right after QR scan, WhatsApp closes the pairing socket with 515 (restartRequired)
        if (isRestartRequired) {
          console.log('🔄 [Baileys] Pairing handshake complete (515). Reconnecting immediately with new credentials...');
          scheduleReconnect(300, true);
          return;
        }

        connectionStatus = 'DISCONNECTED';
        latestQrDataUrl = null;
        botPhoneNumber = null;

        const firestore = db || getDb();
        if (firestore) {
          firestore.collection('settings').doc('config').set({
            botStatus: 'DISCONNECTED',
            botPhoneNumber: '',
            lastDisconnectedAt: new Date().toISOString()
          }, { merge: true }).then(() => {
            console.log('📡 [Firestore] Synced botStatus: DISCONNECTED');
          }).catch((err) => {
            console.error('❌ [Firestore] Failed to sync DISCONNECTED status:', err.message);
          });
        }

        if (isLoggedOut) {
          console.log('❌ Device logged out. Clearing local session and Firestore backup, then restarting for fresh QR...');
          if (fs.existsSync(AUTH_DIR)) {
            try {
              fs.rmSync(AUTH_DIR, { recursive: true, force: true });
              fs.mkdirSync(AUTH_DIR, { recursive: true });
            } catch (err) {
              console.error('Error clearing AUTH_DIR:', err.message);
            }
          }
          if (firestore) {
            firestore.collection('whatsapp_session').doc('backup').delete().catch(() => { });
          }
          // Immediately restart socket to generate new QR code for pairing
          scheduleReconnect(1500, true);
        } else {
          // Reconnect on QR timeout (408) or transient disconnections
          scheduleReconnect(3000, true);
        }
      } else if (connection === 'open') {
        if (mySocketId !== currentSocketId) return;
        isConnecting = false;
        connectionStatus = 'CONNECTED';
        latestQrDataUrl = null;
        const jid = mySock.user?.id || '';
        botPhoneNumber = jid.split(':')[0] || jid.split('@')[0];
        console.log(`✅ [WhatsApp Connected] (Socket #${mySocketId}) Live on WhatsApp account: +${botPhoneNumber}`);
        backupSessionToFirestore(AUTH_DIR, getDb(), true);

        const firestore = db || getDb();
        if (firestore) {
          firestore.collection('settings').doc('config').set({
            botStatus: 'CONNECTED',
            botPhoneNumber: botPhoneNumber,
            lastConnectedAt: new Date().toISOString()
          }, { merge: true }).then(() => {
            console.log(`📡 [Firestore] Synced botStatus: CONNECTED (+${botPhoneNumber})`);
          }).catch((err) => {
            console.error('❌ [Firestore] Failed to sync CONNECTED status:', err.message);
          });
        }
      }
    });

    // Listen for incoming messages (Two-Way YES / NO reply handling)
    mySock.ev.on('messages.upsert', async (m) => {
      if (mySocketId !== currentSocketId) return;
      if (m.type !== 'notify') return;

      for (const msg of m.messages) {
        if (!msg.message || msg.key.fromMe) continue;

        const remoteJid = msg.key.remoteJid || '';
        if (remoteJid.includes('@g.us')) continue; // Ignore groups

        const text = (
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          ''
        ).trim();

        if (!text) continue;

        await handleIncomingReply(text, remoteJid);
      }
    });

  } catch (error) {
    if (mySocketId !== currentSocketId) return;
    console.error('❌ [Baileys Connection Error]:', error);
    isConnecting = false;
    connectionStatus = 'DISCONNECTED';
    scheduleReconnect(5000, true);
  }
}

/**
 * Fetch all registered target WhatsApp numbers from settings/config
 */
async function getTargetPhoneNumbers(db) {
  try {
    const configDoc = await db.collection('settings').doc('config').get();
    if (!configDoc.exists) return [];
    const data = configDoc.data() || {};
    const numbers = [];

    if (Array.isArray(data.targetWhatsAppNumbers) && data.targetWhatsAppNumbers.length > 0) {
      data.targetWhatsAppNumbers.forEach(p => {
        const cleaned = cleanPhoneNumber(p);
        if (cleaned && !numbers.includes(cleaned)) numbers.push(cleaned);
      });
    }

    if (numbers.length === 0 && data.targetWhatsAppNumber) {
      const cleaned = cleanPhoneNumber(data.targetWhatsAppNumber);
      if (cleaned && !numbers.includes(cleaned)) numbers.push(cleaned);
    }

    return numbers;
  } catch (err) {
    console.error('❌ Error fetching target phone numbers:', err.message);
    return [];
  }
}

async function getProcurementTargetPhoneNumbers(db) {
  try {
    const configDoc = await db.collection('settings').doc('config').get();
    if (!configDoc.exists) return [];
    const data = configDoc.data() || {};
    const numbers = [];

    if (Array.isArray(data.procurementTargetWhatsAppNumbers) && data.procurementTargetWhatsAppNumbers.length > 0) {
      data.procurementTargetWhatsAppNumbers.forEach(p => {
        const cleaned = cleanPhoneNumber(p);
        if (cleaned && !numbers.includes(cleaned)) numbers.push(cleaned);
      });
    }

    // Fallback to general target WhatsApp numbers if procurement numbers not set
    if (numbers.length === 0 && Array.isArray(data.targetWhatsAppNumbers)) {
      data.targetWhatsAppNumbers.forEach(p => {
        const cleaned = cleanPhoneNumber(p);
        if (cleaned && !numbers.includes(cleaned)) numbers.push(cleaned);
      });
    }

    if (numbers.length === 0 && data.targetWhatsAppNumber) {
      const cleaned = cleanPhoneNumber(data.targetWhatsAppNumber);
      if (cleaned && !numbers.includes(cleaned)) numbers.push(cleaned);
    }

    return numbers;
  } catch (err) {
    console.error('❌ Error fetching procurement target phone numbers:', err.message);
    return [];
  }
}

async function dispatchProcurementPrompt(db) {
  if (!db || !sock || connectionStatus !== 'CONNECTED') return { count: 0, message: 'Bot offline' };

  const targets = await getProcurementTargetPhoneNumbers(db);
  if (targets.length === 0) {
    console.log('⚠️ [Procurement] No procurement target numbers configured.');
    return { count: 0, message: 'No target numbers' };
  }

  const demandsSnap = await db.collection('procurement_demands')
    .where('isCompleted', '==', false)
    .orderBy('lastUpdatedDate', 'desc')
    .limit(1)
    .get();

  if (demandsSnap.empty) {
    console.log('ℹ️ [Procurement] No active pending demands.');
    return { count: 0, message: 'No pending demands' };
  }

  const doc = demandsSnap.docs[0];
  const demand = { id: doc.id, ...doc.data() };
  const step = WORKFLOW_STEPS[demand.currentStep - 1] || WORKFLOW_STEPS[0];
  const progressPercent = Math.round(((demand.currentStep - 1) / 22) * 100);

  const message = `📋 *SLAF PROCUREMENT WORKFLOW TRACKER*
📁 *Demand No:* *${demand.demandNumber}*
📝 *Topic:* ${demand.topic}
📊 *Progress:* ${demand.currentStep - 1}/22 Completed (${progressPercent}%)

📍 *Current Step ${String(demand.currentStep).padStart(2, '0')}/22 (${step.category}):*
👉 *${step.text}*

_Reply *YES* if done, or *NO* if still pending._`;

  let sent = 0;
  for (const phone of targets) {
    const jid = `${phone}@s.whatsapp.net`;
    try {
      await sock.sendMessage(jid, { text: message });
      console.log(`📤 [Procurement Prompt Sent] to +${phone} for ${demand.demandNumber} (Step ${demand.currentStep}/22)`);
      pendingProcurementPromptByPhone.set(phone, demand);
      sent++;
    } catch (e) {
      console.error(`❌ Failed to send procurement prompt to +${phone}:`, e.message);
    }
  }

  return { count: sent, demandNumber: demand.demandNumber, step: demand.currentStep };
}

/**
 * Calculate Expiry Alert Milestone (3m, 2m, 1m, 14d, 7d, <=3d)
 */
function getAlertMilestone(days, lastAlertSent, isManual = false) {
  if (days === null) return null;

  let milestone = null;

  if (days <= 3) {
    if (lastAlertSent !== '3_DAYS') milestone = '3_DAYS';
  } else if (days <= 7) {
    if (lastAlertSent !== '7_DAYS' && lastAlertSent !== '3_DAYS') milestone = '7_DAYS';
  } else if (days <= 14) {
    if (lastAlertSent !== '14_DAYS' && lastAlertSent !== '7_DAYS' && lastAlertSent !== '3_DAYS') milestone = '14_DAYS';
  } else if (days <= 30) {
    if (lastAlertSent !== '30_DAYS' && lastAlertSent !== '14_DAYS' && lastAlertSent !== '7_DAYS' && lastAlertSent !== '3_DAYS') milestone = '30_DAYS';
  } else if (days <= 60) {
    if (!['60_DAYS', '30_DAYS', '14_DAYS', '7_DAYS', '3_DAYS'].includes(lastAlertSent)) milestone = '60_DAYS';
  } else if (days <= 90) {
    if (!['90_DAYS', '60_DAYS', '30_DAYS', '14_DAYS', '7_DAYS', '3_DAYS'].includes(lastAlertSent)) milestone = '90_DAYS';
  }

  // If manual test triggered, force alert for current tier if within 90 days
  if (isManual && !milestone && days <= 90) {
    if (days <= 3) milestone = '3_DAYS';
    else if (days <= 7) milestone = '7_DAYS';
    else if (days <= 14) milestone = '14_DAYS';
    else if (days <= 30) milestone = '30_DAYS';
    else if (days <= 60) milestone = '60_DAYS';
    else milestone = '90_DAYS';
  }

  return milestone;
}

function getMilestoneDescription(milestone, days) {
  if (days < 0) return `⚠️ *ALREADY EXPIRED (${Math.abs(days)} days ago)*`;
  if (days === 0) return `🚨 *EXPIRES TODAY*`;
  if (milestone === '3_DAYS') return `🚨 *${days} day(s) remaining (CRITICAL / URGENT)*`;
  if (milestone === '7_DAYS') return `⚠️ *1 week remaining (${days} days)*`;
  if (milestone === '14_DAYS') return `⚠️ *2 weeks remaining (${days} days)*`;
  if (milestone === '30_DAYS') return `📅 *1 month remaining (${days} days)*`;
  if (milestone === '60_DAYS') return `📅 *2 months remaining (${days} days)*`;
  if (milestone === '90_DAYS') return `📅 *3 months remaining (${days} days)*`;
  return `*${days} days remaining*`;
}

/**
 * Resolve phone number from JID (handles normal phone JIDs and WhatsApp privacy @lid)
 */
function resolvePhoneFromJid(jid) {
  if (!jid) return '';
  const rawId = jid.split('@')[0].split(':')[0];

  if (jid.includes('@lid')) {
    try {
      const reverseMapPath = path.join(AUTH_DIR, `lid-mapping-${rawId}_reverse.json`);
      if (fs.existsSync(reverseMapPath)) {
        const rawPhone = JSON.parse(fs.readFileSync(reverseMapPath, 'utf8'));
        if (rawPhone) return cleanPhoneNumber(rawPhone);
      }
    } catch (e) {
      // ignore
    }
  }

  return cleanPhoneNumber(rawId);
}

function getLidForPhone(phone) {
  const cleaned = cleanPhoneNumber(phone);
  if (!cleaned) return null;
  try {
    const mapPath = path.join(AUTH_DIR, `lid-mapping-${cleaned}.json`);
    if (fs.existsSync(mapPath)) {
      const rawLid = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
      if (rawLid) return String(rawLid).trim();
    }
  } catch (e) {
    // ignore
  }
  return null;
}

/**
 * Handle Two-Way Replies ("YES" or "NO") with One-by-One Waiting Queue
 */
async function handleIncomingReply(text, remoteJid) {
  const db = getDb();
  if (!db) {
    console.error('❌ Firestore not initialized.');
    return;
  }

  // 1. Fetch Target WhatsApp Numbers from Firestore settings
  const targetNumbers = await getTargetPhoneNumbers(db);
  const procTargetNumbers = await getProcurementTargetPhoneNumbers(db);
  const allTargetNumbers = [...new Set([...targetNumbers, ...procTargetNumbers])];
  const resolvedPhone = resolvePhoneFromJid(remoteJid);
  const rawId = remoteJid.split('@')[0].split(':')[0];

  console.log(`📩 [WhatsApp Received] From: ${remoteJid} (Phone: +${resolvedPhone}) | Message: "${text}"`);

  // Validate sender authorization
  const isAuthorized = allTargetNumbers.length === 0 || allTargetNumbers.some(target => {
    if (resolvedPhone === target || resolvedPhone.endsWith(target) || target.endsWith(resolvedPhone)) return true;
    const knownLid = getLidForPhone(target);
    if (knownLid && (rawId === knownLid || rawId.endsWith(knownLid))) return true;
    return false;
  });

  if (!isAuthorized) {
    console.log(`ℹ️ [Ignored] Message received from non-target identifier: ${rawId} (Resolved: ${resolvedPhone})`);
    return;
  }

  const normalized = text.trim().toUpperCase();
  const isNo = /^(NO|N|REMOVE|FINISH|FINISHED|OUT\s+OF\s+STOCK|CLEAR|NAHA|PNAHA)$/i.test(normalized) || normalized.startsWith('NO');
  const isYes = /^(YES|Y|KEEP|STILL\s+IN\s+STOCK|AVAILABLE|OW|DONE|COMPLETED|HARI)$/i.test(normalized) || normalized.startsWith('YES');

  // Check if this is a Procurement Status Inquiry or Next Prompt trigger
  if (normalized === 'DEMANDS' || normalized === 'FILES' || normalized === 'PROCUREMENT') {
    const snap = await db.collection('procurement_demands').where('isCompleted', '==', false).get();
    if (snap.empty) {
      await sock.sendMessage(remoteJid, { text: `📂 *PROCUREMENT WORKFLOW STATUS*\n\n✅ No active demands pending! All files completed.` });
      return;
    }
    let response = `📂 *ACTIVE PROCUREMENT FILES (${snap.size})*\n\n`;
    snap.docs.forEach((doc, idx) => {
      const d = doc.data();
      const step = WORKFLOW_STEPS[d.currentStep - 1] || WORKFLOW_STEPS[0];
      response += `${idx + 1}. *${d.demandNumber}*\n   📍 Step ${d.currentStep}/22: _${step.text}_\n`;
    });
    response += `\n_Reply *PROMPT* to receive the next active question._`;
    await sock.sendMessage(remoteJid, { text: response });
    return;
  }

  if (normalized === 'PROMPT' || normalized === 'CHECK PROC') {
    await dispatchProcurementPrompt(db);
    return;
  }

  // Check if sender is responding to a Procurement Workflow Prompt
  let targetDemand = pendingProcurementPromptByPhone.get(resolvedPhone);

  // Fallback: If not in memory cache, check if sender is a procurement target and has active demands
  if (!targetDemand && (isYes || isNo)) {
    const isProcTarget = procTargetNumbers.some(t => resolvedPhone === t || resolvedPhone.endsWith(t) || t.endsWith(resolvedPhone));
    if (isProcTarget) {
      const snap = await db.collection('procurement_demands')
        .where('isCompleted', '==', false)
        .orderBy('lastUpdatedDate', 'desc')
        .limit(1)
        .get();
      if (!snap.empty) {
        const doc = snap.docs[0];
        targetDemand = { id: doc.id, ...doc.data() };
      }
    }
  }

  if (targetDemand && (isYes || isNo)) {
    const now = new Date().toISOString();
    const currentStep = targetDemand.currentStep;
    const currentStepInfo = WORKFLOW_STEPS[currentStep - 1] || WORKFLOW_STEPS[0];

    if (isYes) {
      const docRef = db.collection('procurement_demands').doc(targetDemand.id);
      const docSnap = await docRef.get();
      const history = docSnap.get('history') || [];

      history.push({
        stepIndex: currentStep,
        stepName: currentStepInfo.text,
        completedAt: new Date().toLocaleString('en-GB', { timeZone: 'Asia/Colombo' }),
        completedBy: `+${resolvedPhone}`
      });

      if (currentStep < 22) {
        const nextStep = currentStep + 1;
        const nextStepInfo = WORKFLOW_STEPS[nextStep - 1];

        await docRef.update({
          currentStep: nextStep,
          isCompleted: false,
          lastUpdatedDate: now,
          history: history
        });

        console.log(`✅ [Procurement Step Advanced] ${targetDemand.demandNumber} moved to Step ${nextStep}/22`);

        await sock.sendMessage(remoteJid, {
          text: `✅ *STEP ${currentStep}/22 COMPLETED!*
📁 *Demand:* *${targetDemand.demandNumber}*
✓ *Finished:* ${currentStepInfo.title}

📍 *Next Step ${nextStep}/22 (${nextStepInfo.category}):*
👉 *${nextStepInfo.text}*

_Reply *YES* when finished, or *NO* if still working on it._`
        });

        pendingProcurementPromptByPhone.set(resolvedPhone, {
          ...targetDemand,
          currentStep: nextStep
        });
      } else {
        await docRef.update({
          currentStep: 22,
          isCompleted: true,
          lastUpdatedDate: now,
          history: history
        });

        console.log(`🎉 [Procurement Completed] ${targetDemand.demandNumber} finished all 22 steps!`);

        await sock.sendMessage(remoteJid, {
          text: `🎉 *CONGRATULATIONS! ALL 22 STEPS FINISHED!*
📁 *Demand No:* *${targetDemand.demandNumber}*
📝 *Topic:* ${targetDemand.topic}
✅ *Final Step 22 Completed:* Bill forwarded to HQ for payment.

_This demand is now marked as COMPLETED in the Dashboard._`
        });

        pendingProcurementPromptByPhone.delete(resolvedPhone);
      }
    } else if (isNo) {
      console.log(`⏳ [Procurement Pending] ${targetDemand.demandNumber} remains at Step ${currentStep}/22`);
      await sock.sendMessage(remoteJid, {
        text: `⏳ *UNDERSTOOD!*
📁 *Demand:* *${targetDemand.demandNumber}*
File remains at *Step ${currentStep}/22*:
👉 *${currentStepInfo.text}*

_When this step is finished, simply reply *YES*._`
      });
    }
    return;
  }

  // 2. Load One-by-One Waiting Queue first (persisted in Firestore)
  const queue = await loadAlertQueue(db);
  let targetBatch = queue.length > 0 ? queue[0] : null;

  if (!targetBatch) {
    targetBatch = activeBatchAlerts.get(resolvedPhone) || activeBatchAlerts.get(rawId);
  }

  if (!targetBatch && activeBatchAlerts.size === 1) {
    targetBatch = Array.from(activeBatchAlerts.values())[0];
  }

  if (!targetBatch) {
    // Fallback: Query nearest expiring batch from Firestore
    const batchesSnap = await db.collection('stock_batches')
      .orderBy('expiryDate', 'asc')
      .limit(1)
      .get();

    if (!batchesSnap.empty) {
      const doc = batchesSnap.docs[0];
      targetBatch = { batchId: doc.id, ...doc.data() };
    }
  }

  if (!targetBatch) {
    await sock.sendMessage(remoteJid, {
      text: 'ℹ️ No pending active batches found requiring review. All store alerts are currently up to date.'
    });
    return;
  }

  const expDateStr = formatDisplayDate(targetBatch.expiryDate);
  const progressLabel = targetBatch.total ? ` (${targetBatch.index}/${targetBatch.total})` : '';

  if (isNo) {
    // AUTOMATICALLY DELETE BATCH DOCUMENT FROM FIRESTORE
    try {
      await db.collection('stock_batches').doc(targetBatch.batchId).delete();
      console.log(`🗑️ [Batch Deleted] Successfully deleted batch ${targetBatch.batchId} (${targetBatch.itemName}) from Firestore.`);

      activeBatchAlerts.delete(resolvedPhone);
      activeBatchAlerts.delete(rawId);

      // Remove current item from front of queue
      if (queue.length > 0 && queue[0].batchId === targetBatch.batchId) {
        queue.shift();
        await saveAlertQueue(db, queue);
      }

      if (queue.length > 0) {
        const replyText = `✅ *Removed from Stock${progressLabel}:*
*${targetBatch.itemName}* (Exp: ${expDateStr}) has been cleared from store stock batches.`;
        await sock.sendMessage(remoteJid, { text: replyText });

        // Immediately send the NEXT item waiting in the queue!
        const nextSent = await dispatchNextFromQueue(db, targetNumbers, true);
        if (!nextSent) {
          await sock.sendMessage(remoteJid, {
            text: `🎉 *All pending expiry alerts${targetBatch.total ? ` (${targetBatch.total}/${targetBatch.total})` : ''} have been reviewed!*`
          });
        }
      } else {
        const replyText = `✅ *Removed from Active Tracking${progressLabel}:*
*${targetBatch.itemName}* (Exp: ${expDateStr}) has been cleared from store stock batches.
No further expiry warnings will be sent.

🎉 *All pending expiry alerts${targetBatch.total ? ` (${targetBatch.total}/${targetBatch.total})` : ''} have been reviewed!*`;
        await sock.sendMessage(remoteJid, { text: replyText });
      }
    } catch (err) {
      console.error('❌ Error deleting batch document:', err);
    }
  } else if (isYes) {
    // KEEP BATCH ACTIVE
    activeBatchAlerts.delete(resolvedPhone);
    activeBatchAlerts.delete(rawId);

    // Remove current item from front of queue
    if (queue.length > 0 && queue[0].batchId === targetBatch.batchId) {
      queue.shift();
      await saveAlertQueue(db, queue);
    }

    if (queue.length > 0) {
      const replyText = `👍 *Kept Active${progressLabel}:*
*${targetBatch.itemName}* (Exp: ${expDateStr}) remains active in store tracking.`;
      await sock.sendMessage(remoteJid, { text: replyText });

      // Immediately send the NEXT item waiting in the queue!
      const nextSent = await dispatchNextFromQueue(db, targetNumbers, true);
      if (!nextSent) {
        await sock.sendMessage(remoteJid, {
          text: `🎉 *All pending expiry alerts${targetBatch.total ? ` (${targetBatch.total}/${targetBatch.total})` : ''} have been reviewed!*`
        });
      }
    } else {
      const replyText = `👍 *Kept Active${progressLabel}:*
*${targetBatch.itemName}* (Exp: ${expDateStr}) remains active in store tracking.
Next reminder will be sent as scheduled.

🎉 *All pending expiry alerts${targetBatch.total ? ` (${targetBatch.total}/${targetBatch.total})` : ''} have been reviewed!*`;
      await sock.sendMessage(remoteJid, { text: replyText });
    }
  } else {
    // HELP PROMPT
    const replyText = `❓ Regarding${progressLabel}: *${targetBatch.itemName}* (Exp: ${expDateStr})
Please reply:
• *YES* — to keep tracking this batch in store
• *NO* — to remove batch (stock finished)`;

    await sock.sendMessage(remoteJid, { text: replyText });
  }
}

/**
 * Daily Automated Expiry Audit (Triggered via cron at 08:00 AM Asia/Colombo)
 * Uses One-by-One Sequential Waiting Queue so alerts never overwrite each other
 */
async function runDailyExpiryAudit(isManual = false) {
  console.log(`⏰ [Audit] Running expiry audit (Manual: ${isManual}, Time: ${new Date().toLocaleString('en-US', { timeZone: 'Asia/Colombo' })})...`);

  const db = getDb();
  if (!db) {
    console.error('❌ Cannot run audit: Firestore is not connected.');
    return { count: 0, error: 'Firestore disconnected' };
  }

  // 1. Fetch Target WhatsApp Numbers from settings/config
  const targetNumbers = await getTargetPhoneNumbers(db);
  if (targetNumbers.length === 0) {
    console.log('⚠️ [Audit] No target WhatsApp numbers configured in settings/config.');
    return { count: 0, message: 'targetWhatsAppNumbers empty' };
  }

  // 2. Fetch all batches from stock_batches collection
  const snapshot = await db.collection('stock_batches').get();
  if (snapshot.empty) {
    console.log('ℹ️ [Audit] No batches found in stock_batches collection.');
    await saveAlertQueue(db, []);
    return { count: 0, message: 'No batches' };
  }

  // 3. Collect all batches that hit an alert milestone
  const candidates = [];
  for (const doc of snapshot.docs) {
    const batch = doc.data();
    const batchId = doc.id;
    const days = getDaysRemaining(batch.expiryDate);

    if (days === null) continue;

    // Check Milestones: 3m (90d), 2m (60d), 1m (30d), 14d, 7d, <=3d
    const milestone = getAlertMilestone(days, batch.lastAlertSent, isManual);

    if (milestone) {
      candidates.push({
        batchId,
        itemName: batch.itemName,
        expiryDate: formatDateString(batch.expiryDate),
        days,
        milestone,
        milestoneDesc: getMilestoneDescription(milestone, days)
      });
    }
  }

  if (candidates.length === 0) {
    console.log('🏁 [Audit Finished] No batches require alerts today.');
    return { count: 0, totalQueued: 0, recipients: targetNumbers.length };
  }

  // 4. Sort by most urgent first (fewest days remaining first)
  candidates.sort((a, b) => a.days - b.days);

  const total = candidates.length;
  const queueItems = candidates.map((item, idx) => ({
    ...item,
    index: idx + 1,
    total
  }));

  // 5. Persist queue in Firestore and memory, then dispatch ONLY the 1st item (#1 of N)
  await saveAlertQueue(db, queueItems);
  console.log(`📋 [Audit Queue Created] ${total} item(s) queued in order of urgency. Dispatching item 1 of ${total}...`);

  const firstDispatched = await dispatchNextFromQueue(db, targetNumbers, false);
  const alertsDispatched = firstDispatched ? 1 : 0;

  console.log(`🏁 [Audit Finished] Dispatched 1st alert (${firstDispatched?.itemName || 'none'}); ${Math.max(0, total - 1)} remaining in waiting queue.`);
  return { count: alertsDispatched, totalQueued: total, recipients: targetNumbers.length };
}

// -------------------------------------------------------------
// Scheduled Cron: Runs every day at 08:00 AM (Asia/Colombo)
// -------------------------------------------------------------
cron.schedule('0 8 * * *', () => {
  runDailyExpiryAudit(false);
}, {
  timezone: 'Asia/Colombo'
});

// -------------------------------------------------------------
// Express Web Routes & Dashboard
// -------------------------------------------------------------
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Ration Store WhatsApp Automation Service</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0b1120; color: #f8fafc; padding: 30px; text-align: center; }
          .card { max-width: 600px; margin: 0 auto; background: #1e293b; padding: 25px; border-radius: 16px; border: 1px solid #334155; }
          .badge { display: inline-block; padding: 6px 14px; border-radius: 20px; font-weight: bold; font-size: 0.85rem; margin-top: 10px; }
          .connected { background: #065f46; color: #6ee7b7; border: 1px solid #10b981; }
          .qr_ready { background: #854d0e; color: #fef08a; border: 1px solid #facc15; }
          .disconnected { background: #991b1b; color: #fca5a5; border: 1px solid #ef4444; }
          .btn { display: inline-block; padding: 10px 18px; background: #0284c7; color: white; text-decoration: none; border-radius: 8px; margin: 8px; font-weight: 600; cursor: pointer; border: none; font-size: 0.95rem; }
          .btn-emerald { background: #10b981; }
          .btn-danger { background: #dc2626; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>🏢 Ration Store WhatsApp Automation Service</h2>
          <p style="color: #94a3b8;">100% Free Baileys Engine synced with Firebase Firestore</p>
          <div>
            Status: 
            <span class="badge ${connectionStatus.toLowerCase()}">${connectionStatus}</span>
          </div>
          ${botPhoneNumber ? `<p style="color: #38bdf8; font-family: monospace; font-size: 1.15rem; margin-top: 15px;">Connected Bot Phone: <strong>+${botPhoneNumber}</strong></p>` : ''}
          <div style="margin-top: 25px;">
            <a class="btn btn-emerald" href="/qr">📱 Scan QR Code</a>
            <a class="btn" href="/inspection" style="background:#0284c7;">📋 Inspection Dashboard</a>
            <button class="btn" onclick="fetch('/api/check-now', {method: 'POST'}).then(r=>r.json()).then(d=>alert('Audit Triggered: ' + JSON.stringify(d)))">⚡ Run Expiry Check Now</button>
            ${connectionStatus === 'CONNECTED' ? `<button class="btn btn-danger" onclick="if(confirm('Are you sure you want to change the sender bot account? This will unlink +${botPhoneNumber} and generate a new QR code.')){ fetch('/api/logout', {method: 'POST'}).then(() => window.location='/qr'); }">🔄 Change / Unlink Bot Number</button>` : ''}
          </div>
        </div>
      </body>
    </html>
  `);
});

app.get('/qr', (req, res) => {
  if (connectionStatus === 'CONNECTED') {
    return res.send(`
      <!DOCTYPE html>
      <html>
        <head><title>WhatsApp Connected</title><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0b1120; color: #f8fafc; padding: 40px; text-align: center;">
          <h2 style="color: #10b981;">✅ WhatsApp Connected Successfully!</h2>
          <p>Linked Sender Phone Number: <strong style="font-size: 1.2rem; color: #38bdf8;">+${botPhoneNumber}</strong></p>
          <p style="color: #94a3b8;">The bot is currently active, sending expiry alerts and processing YES/NO stock reviews.</p>
          <div style="margin-top: 30px;">
            <a href="/" style="display: inline-block; padding: 10px 20px; background: #0284c7; color: white; text-decoration: none; border-radius: 8px; margin: 8px; font-weight: bold;">&larr; Back to Dashboard</a>
            <button onclick="if(confirm('Do you want to unlink +${botPhoneNumber} and pair a different phone number?')){ fetch('/api/logout', {method: 'POST'}).then(() => window.location.reload()); }" style="display: inline-block; padding: 10px 20px; background: #dc2626; color: white; border: none; border-radius: 8px; margin: 8px; font-weight: bold; cursor: pointer;">🔄 Change / Pair Different Number</button>
          </div>
        </body>
      </html>
    `);
  }

  // If bot is not connected and no QR is generated yet, ensure socket is connecting
  if (!latestQrDataUrl && connectionStatus !== 'CONNECTING') {
    console.log('📲 [/qr accessed] No active QR and not connecting. Triggering connectToWhatsApp()...');
    connectToWhatsApp();
  }

  if (!latestQrDataUrl) {
    return res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Generating QR...</title>
          <meta http-equiv="refresh" content="5">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <script>
            setInterval(async function() {
              try {
                const r = await fetch('/api/status');
                const data = await r.json();
                if (data.status === 'CONNECTED' || data.hasQr) {
                  window.location.reload();
                }
              } catch (e) {}
            }, 2000);
          </script>
        </head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0b1120; color: #f8fafc; padding: 40px; text-align: center;">
          <div style="max-width: 400px; margin: 40px auto; background: #1e293b; padding: 30px; border-radius: 16px; border: 1px solid #334155;">
            <div style="display: inline-block; width: 40px; height: 40px; border: 4px solid #334155; border-top-color: #38bdf8; border-radius: 50%; animation: spin 1s linear infinite; margin-bottom: 20px;"></div>
            <h2 style="margin: 0 0 10px 0; color: #38bdf8;">Generating WhatsApp QR Code...</h2>
            <p style="color: #94a3b8; font-size: 0.95rem; line-height: 1.5;">Connecting to WhatsApp servers. This page will refresh automatically as soon as ready...</p>
            <div style="margin-top: 15px;">
              <button onclick="window.location.reload()" style="padding: 8px 16px; background: #334155; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 0.85rem; margin-right: 8px;">🔄 Tap to Reload</button>
              <button onclick="if(confirm('Reset WhatsApp session to force an immediate new QR code?')){ fetch('/api/logout', {method:'POST'}).then(function(){ setTimeout(function(){ window.location.reload(); }, 1500); }); }" style="padding: 8px 16px; background: #dc2626; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 0.85rem; font-weight: bold;">⚡ Reset Session</button>
            </div>
          </div>
          <style>
            @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
          </style>
        </body>
      </html>
    `);
  }

  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Pair WhatsApp - Ration Store</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <script>
          let lastQr = "${latestQrDataUrl}";
          setInterval(async function() {
            try {
              const r = await fetch('/api/status');
              const data = await r.json();
              if (data.status === 'CONNECTED') {
                window.location.reload();
              } else if (data.qrDataUrl && data.qrDataUrl !== lastQr) {
                lastQr = data.qrDataUrl;
                const img = document.getElementById('qr-img');
                if (img) img.src = data.qrDataUrl;
              }
            } catch (e) {}
          }, 2000);
        </script>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0b1120; color: #f8fafc; padding: 20px; text-align: center; }
          .qr-box { max-width: 440px; margin: 0 auto; background: #1e293b; padding: 20px; border-radius: 16px; border: 1px solid #334155; }
          img { border-radius: 10px; background: white; padding: 10px; max-width: 280px; width: 100%; height: auto; display: block; margin: 0 auto; }
          ol { text-align: left; color: #94a3b8; font-size: 0.88rem; line-height: 1.6; padding-left: 20px; }
          .btn-refresh { display: inline-block; margin-top: 12px; padding: 8px 16px; background: #0284c7; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 0.85rem; font-weight: 600; text-decoration: none; margin-right: 8px; }
          .btn-reset { display: inline-block; margin-top: 12px; padding: 8px 16px; background: #dc2626; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 0.85rem; font-weight: 600; }
        </style>
      </head>
      <body>
        <div class="qr-box">
          <h2 style="margin-top: 0; color: #10b981; font-size: 1.3rem;">📱 Link WhatsApp Device</h2>
          <img id="qr-img" src="${latestQrDataUrl}" alt="WhatsApp QR Code" />
          <ol>
            <li>Open <strong>WhatsApp</strong> on the Bot Phone.</li>
            <li>Tap <strong>Settings</strong> or <strong>Menu (⋮)</strong> &rarr; <strong>Linked Devices</strong>.</li>
            <li>Tap <strong>Link a Device</strong> and scan this QR code.</li>
          </ol>
          <div>
            <button class="btn-refresh" onclick="window.location.reload()">🔄 Refresh QR Code</button>
            <button class="btn-reset" onclick="if(confirm('Generate a brand new QR code?')){ fetch('/api/logout', {method:'POST'}).then(function(){ setTimeout(function(){ window.location.reload(); }, 1500); }); }">⚡ Force Fresh QR</button>
          </div>
          <p style="font-size: 0.75rem; color: #64748b; margin-top: 10px;">Auto-syncs live every 2 seconds. Never expires.</p>
        </div>
      </body>
    </html>
  `);
});

// -------------------------------------------------------------
// Live Expiry Inspection Dashboard for CO / Director / Audits
// Accessible via standard mobile phone camera QR scan
// -------------------------------------------------------------
app.get('/inspection', async (req, res) => {
  try {
    const db = getDb();
    if (!db) {
      return res.status(500).send('<h2>Database not connected. Please try again.</h2>');
    }

    const batchesSnap = await db.collection('stock_batches').get();
    const masterSnap = await db.collection('master_items').get();

    const masterMap = {};
    masterSnap.forEach(doc => {
      masterMap[doc.id] = doc.data();
    });

    const items = [];
    batchesSnap.forEach(doc => {
      const data = doc.data();
      const days = getDaysRemaining(data.expiryDate);
      const master = masterMap[data.itemId] || {};
      const unit = master.unit || 'NOS';
      const itemName = data.itemName || master.itemName || 'Unknown Item';
      items.push({
        batchId: doc.id,
        itemId: data.itemId || '-',
        itemName: itemName,
        unit: unit,
        expiryDate: data.expiryDate || '',
        displayDate: formatDisplayDate(data.expiryDate),
        days: days !== null ? days : 9999
      });
    });

    // Sort ascending by remaining days (nearest expiry first)
    items.sort((a, b) => a.days - b.days);

    let countExpired = 0;
    let countCritical = 0; // 0 - 3
    let countUrgent = 0;   // 4 - 14
    let countWarning = 0;  // 15 - 30
    let countSafe = 0;     // > 30

    items.forEach(it => {
      if (it.days < 0) countExpired++;
      else if (it.days <= 3) countCritical++;
      else if (it.days <= 14) countUrgent++;
      else if (it.days <= 30) countWarning++;
      else countSafe++;
    });

    const nowFormatted = new Date().toLocaleString('en-GB', {
      timeZone: 'Asia/Colombo',
      dateStyle: 'medium',
      timeStyle: 'short'
    });

    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SLAF Ration Store - Live Expiry Inspection</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
    body { background-color: #0b1120; color: #f8fafc; padding: 16px; min-height: 100vh; }
    .container { max-width: 900px; margin: 0 auto; }
    
    /* Header */
    .header { background: #1e293b; border: 1px solid #334155; border-radius: 14px; padding: 20px; text-align: center; margin-bottom: 16px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.3); }
    .header h3 { color: #38bdf8; font-size: 0.85rem; letter-spacing: 2px; text-transform: uppercase; margin-bottom: 6px; font-weight: 800; }
    .header h1 { font-size: 1.5rem; color: #ffffff; margin-bottom: 6px; font-weight: 900; }
    .header .timestamp { color: #94a3b8; font-size: 0.82rem; }
    .header .refresh-btn { display: inline-flex; align-items: center; gap: 6px; margin-top: 12px; padding: 7px 16px; background: #0284c7; color: white; border: none; border-radius: 8px; font-size: 0.85rem; font-weight: bold; cursor: pointer; text-decoration: none; }
    .header .refresh-btn:hover { background: #0369a1; }

    /* Summary Metrics Grid */
    .metrics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; margin-bottom: 16px; }
    .metric-card { background: #1e293b; border-radius: 10px; padding: 12px; text-align: center; border: 1px solid #334155; cursor: pointer; transition: transform 0.15s ease, border-color 0.15s ease; }
    .metric-card:hover { transform: translateY(-2px); }
    .metric-card.active { border-color: #38bdf8; background: #243247; }
    .metric-val { font-size: 1.6rem; font-weight: 900; margin-bottom: 2px; }
    .metric-label { font-size: 0.75rem; text-transform: uppercase; font-weight: 700; color: #94a3b8; }
    
    .c-total { color: #38bdf8; }
    .c-critical { color: #ef4444; }
    .c-urgent { color: #f97316; }
    .c-warning { color: #facc15; }
    .c-safe { color: #10b981; }

    /* Search & Filter Toolbar */
    .toolbar { display: flex; gap: 10px; margin-bottom: 16px; flex-wrap: wrap; }
    .search-box { flex: 1; min-width: 240px; padding: 12px 16px; background: #1e293b; border: 1px solid #334155; border-radius: 10px; color: #ffffff; font-size: 0.95rem; outline: none; }
    .search-box:focus { border-color: #38bdf8; }

    /* Items List / Cards */
    .items-container { display: flex; flex-direction: column; gap: 10px; }
    .item-card { background: #1e293b; border-radius: 10px; padding: 14px 16px; border: 1px solid #334155; border-left: 6px solid #64748b; display: flex; flex-direction: column; gap: 8px; transition: background 0.15s ease; }
    .item-card.critical { border-left-color: #ef4444; background: rgba(239, 68, 68, 0.08); }
    .item-card.urgent { border-left-color: #f97316; background: rgba(249, 115, 22, 0.08); }
    .item-card.warning { border-left-color: #facc15; background: rgba(250, 204, 21, 0.08); }
    .item-card.safe { border-left-color: #10b981; }
    
    .card-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
    .item-id-pill { background: #0f172a; color: #38bdf8; font-weight: 800; font-size: 0.75rem; padding: 3px 8px; border-radius: 6px; border: 1px solid #334155; display: inline-block; }
    .item-unit { color: #94a3b8; font-size: 0.78rem; font-weight: 600; margin-left: 6px; }
    .item-name { font-size: 1.05rem; font-weight: 800; color: #ffffff; margin-top: 4px; line-height: 1.3; }

    .status-badge { font-size: 0.75rem; font-weight: 800; padding: 4px 10px; border-radius: 20px; white-space: nowrap; text-transform: uppercase; letter-spacing: 0.5px; }
    .badge-critical { background: #ef4444; color: #ffffff; animation: pulse 2s infinite; }
    .badge-urgent { background: #f97316; color: #ffffff; }
    .badge-warning { background: #facc15; color: #000000; }
    .badge-safe { background: #10b981; color: #ffffff; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.7; } }

    .card-bottom { display: flex; justify-content: space-between; align-items: center; border-top: 1px dashed #334155; padding-top: 8px; font-size: 0.85rem; color: #cbd5e1; flex-wrap: wrap; gap: 6px; }
    .exp-date { font-weight: 700; color: #f8fafc; }
    .days-left { font-weight: 800; }

    .empty-state { text-align: center; padding: 40px 20px; background: #1e293b; border-radius: 12px; border: 1px solid #334155; color: #94a3b8; }
    
    @media (min-width: 600px) {
      .header h1 { font-size: 1.8rem; }
      .card-top { align-items: center; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h3>Sri Lanka Air Force • Catering Supply Depot</h3>
      <h1>Live Expiry Inspection Dashboard</h1>
      <div class="timestamp">📡 Real-Time Audit • Generated on ${nowFormatted}</div>
      <a href="/inspection" class="refresh-btn">🔄 Refresh Stock Data</a>
    </div>

    <!-- Urgency Metrics Filters -->
    <div class="metrics-grid">
      <div class="metric-card active" onclick="setFilter('ALL', this)">
        <div class="metric-val c-total">${items.length}</div>
        <div class="metric-label">All Batches</div>
      </div>
      <div class="metric-card" onclick="setFilter('CRITICAL', this)">
        <div class="metric-val c-critical">${countCritical + countExpired}</div>
        <div class="metric-label">≤ 3 Days (Critical)</div>
      </div>
      <div class="metric-card" onclick="setFilter('URGENT', this)">
        <div class="metric-val c-urgent">${countUrgent}</div>
        <div class="metric-label">4 - 14 Days</div>
      </div>
      <div class="metric-card" onclick="setFilter('WARNING', this)">
        <div class="metric-val c-warning">${countWarning}</div>
        <div class="metric-label">15 - 30 Days</div>
      </div>
      <div class="metric-card" onclick="setFilter('SAFE', this)">
        <div class="metric-val c-safe">${countSafe}</div>
        <div class="metric-label">&gt; 30 Days</div>
      </div>
    </div>

    <!-- Search input -->
    <div class="toolbar">
      <input type="text" id="searchBox" class="search-box" placeholder="🔍 Search item name, ID (e.g. RAT-001), or date..." oninput="filterList()">
    </div>

    <!-- Items List -->
    <div class="items-container" id="itemsList">
      ${items.length === 0 ? '<div class="empty-state"><h3>⚪ No active batches found in store</h3></div>' : ''}
      ${items.map(it => {
      let category = 'safe';
      let badgeClass = 'badge-safe';
      let badgeText = 'SAFE';
      let daysText = it.days + ' days remaining';

      if (it.days < 0) {
        category = 'critical';
        badgeClass = 'badge-critical';
        badgeText = 'EXPIRED';
        daysText = '⚠️ Expired (' + Math.abs(it.days) + 'd ago)';
      } else if (it.days === 0) {
        category = 'critical';
        badgeClass = 'badge-critical';
        badgeText = 'CRITICAL';
        daysText = '🔴 EXPIRES TODAY';
      } else if (it.days <= 3) {
        category = 'critical';
        badgeClass = 'badge-critical';
        badgeText = 'CRITICAL';
        daysText = '🔴 ' + String(it.days).padStart(2, '0') + ' days remaining';
      } else if (it.days <= 14) {
        category = 'urgent';
        badgeClass = 'badge-urgent';
        badgeText = 'URGENT';
        daysText = '🟠 ' + String(it.days).padStart(2, '0') + ' days remaining';
      } else if (it.days <= 30) {
        category = 'warning';
        badgeClass = 'badge-warning';
        badgeText = 'WARNING';
        daysText = '🟡 ' + it.days + ' days remaining';
      } else {
        category = 'safe';
        badgeClass = 'badge-safe';
        badgeText = 'SAFE';
        daysText = '🟢 ' + it.days + ' days remaining';
      }

      return `
          <div class="item-card ${category}" data-category="${category}" data-search="${(it.itemName + ' ' + it.itemId + ' ' + it.displayDate + ' ' + it.unit).toLowerCase()}">
            <div class="card-top">
              <div>
                <span class="item-id-pill">${it.itemId}</span>
                <span class="item-unit">D OF Q: ${it.unit}</span>
                <div class="item-name">${it.itemName}</div>
              </div>
              <span class="status-badge ${badgeClass}">${badgeText}</span>
            </div>
            <div class="card-bottom">
              <div>Expiry Date: <span class="exp-date">${it.displayDate}</span></div>
              <div class="days-left">${daysText}</div>
            </div>
          </div>
        `;
    }).join('')}
    </div>
  </div>

  <script>
    let activeFilter = 'ALL';

    function setFilter(filter, el) {
      activeFilter = filter;
      document.querySelectorAll('.metric-card').forEach(c => c.classList.remove('active'));
      el.classList.add('active');
      filterList();
    }

    function filterList() {
      const q = document.getElementById('searchBox').value.trim().toLowerCase();
      const cards = document.querySelectorAll('.item-card');
      let visibleCount = 0;

      cards.forEach(card => {
        const cat = card.getAttribute('data-category');
        const searchData = card.getAttribute('data-search');

        let matchesCat = (activeFilter === 'ALL') || (activeFilter.toLowerCase() === cat);
        let matchesQuery = !q || searchData.includes(q);

        if (matchesCat && matchesQuery) {
          card.style.display = 'flex';
          visibleCount++;
        } else {
          card.style.display = 'none';
        }
      });
    }
  </script>
</body>
</html>
    `;

    res.send(html);
  } catch (err) {
    console.error('❌ Error rendering /inspection:', err.message);
    res.status(500).send('<h2>Error loading inspection report: ' + err.message + '</h2>');
  }
});

app.get('/api/info', (req, res) => {
  res.json({
    app: 'Ration Store WhatsApp Automation Service',
    version: '2.7.0',
    socketId: currentSocketId,
    connectionStatus,
    botPhoneNumber,
    hasQr: Boolean(latestQrDataUrl),
    queueLength: pendingAlertQueue.length,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/status', (req, res) => {
  res.json({
    status: connectionStatus,
    botPhoneNumber,
    hasQr: Boolean(latestQrDataUrl),
    qrDataUrl: latestQrDataUrl
  });
});

app.post('/api/logout', async (req, res) => {
  try {
    console.log(`🔄 [WhatsApp Logout] Changing/Unlinking current bot account (+${botPhoneNumber})...`);

    const oldSock = sock;
    isConnecting = false;
    destroyCurrentSocket();
    if (oldSock) {
      try { await oldSock.logout(); } catch (e) { }
    }

    connectionStatus = 'DISCONNECTED';
    latestQrDataUrl = null;
    botPhoneNumber = null;

    // 1. Wipe local session directory
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      fs.mkdirSync(AUTH_DIR, { recursive: true });
      console.log('🗑️ [Session] Local auth directory cleared.');
    }

    // 2. Wipe Firestore session backup and set botStatus to DISCONNECTED
    const db = getDb();
    if (db) {
      await db.collection('whatsapp_session').doc('backup').delete().catch(() => { });
      await db.collection('settings').doc('config').set({
        botStatus: 'DISCONNECTED',
        botPhoneNumber: '',
        lastDisconnectedAt: new Date().toISOString()
      }, { merge: true }).catch(() => { });
      console.log('🗑️ [Session] Firestore session backup cleared and botStatus set to DISCONNECTED.');
    }

    // 3. Immediately reinitialize connection so new QR is generated
    scheduleReconnect(1000, true);

    res.json({ success: true, message: 'Bot account unlinked. New QR code is ready.' });
  } catch (err) {
    console.error('❌ Error during logout/unlink:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/check-now', async (req, res) => {
  try {
    const result = await runDailyExpiryAudit(true);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/procurement/check-now', async (req, res) => {
  try {
    const db = getDb();
    const result = await dispatchProcurementPrompt(db);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Daily Procurement Workflow Prompt Cron at 08:30 AM
cron.schedule('30 8 * * *', () => {
  console.log('⏰ [Daily Cron] Dispatching daily procurement workflow prompt (08:30 AM)...');
  const db = getDb();
  if (db) dispatchProcurementPrompt(db);
}, { timezone: 'Asia/Colombo' });

// Start Server & Connect
app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🤖 RATION STORE WHATSAPP SERVICE ONLINE`);
  console.log(`📡 Dashboard: http://localhost:${PORT}`);
  console.log(`📲 QR Pairing: http://localhost:${PORT}/qr`);
  console.log(`⏰ Daily Expiry Check: 08:00 AM (Asia/Colombo)`);
  console.log(`=======================================================`);

  // Initialize Firebase and WhatsApp
  getDb();
  connectToWhatsApp();
});
