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

// Track last alerted batch per target phone for direct interactive YES/NO replies
const activeBatchAlerts = new Map();

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
async function connectToWhatsApp() {
  connectionStatus = 'CONNECTING';
  latestQrDataUrl = null;

  try {
    const db = getDb();
    await restoreSessionFromFirestore(AUTH_DIR, db);

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    console.log(`🤖 [Baileys] Initializing WhatsApp Socket (v${version.join('.')})...`);

    sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      auth: state,
      printQRInTerminal: true,
      browser: ['Ration Store Depot', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', async () => {
      await saveCreds();
      backupSessionToFirestore(AUTH_DIR, getDb());
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        connectionStatus = 'QR_READY';
        latestQrDataUrl = await QRCode.toDataURL(qr, { width: 340, margin: 2 });
        console.log('📲 [WhatsApp QR Ready] Scan QR code from terminal or visit http://localhost:' + PORT + '/qr');
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log(`⚠️ [WhatsApp Disconnected] Reason: ${statusCode}. Reconnecting: ${shouldReconnect}`);
        connectionStatus = 'DISCONNECTED';
        latestQrDataUrl = null;
        botPhoneNumber = null;

        if (shouldReconnect) {
          setTimeout(connectToWhatsApp, 5000);
        } else {
          console.log('❌ Device logged out. Clearing session.');
          if (db) {
            db.collection('whatsapp_session').doc('backup').delete().catch(() => {});
          }
        }
      } else if (connection === 'open') {
        connectionStatus = 'CONNECTED';
        latestQrDataUrl = null;
        const jid = sock.user?.id || '';
        botPhoneNumber = jid.split(':')[0] || jid.split('@')[0];
        console.log(`✅ [WhatsApp Connected] Service running live on WhatsApp account: +${botPhoneNumber}`);
        backupSessionToFirestore(AUTH_DIR, getDb(), true);
      }
    });

    // Listen for incoming messages (Two-Way YES / NO reply handling)
    sock.ev.on('messages.upsert', async (m) => {
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
    console.error('❌ [Baileys Connection Error]:', error);
    connectionStatus = 'DISCONNECTED';
    setTimeout(connectToWhatsApp, 8000);
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
 * Handle Two-Way Replies ("YES" or "NO")
 */
async function handleIncomingReply(text, remoteJid) {
  const db = getDb();
  if (!db) {
    console.error('❌ Firestore not initialized.');
    return;
  }

  // 1. Fetch Target WhatsApp Numbers from Firestore settings
  const targetNumbers = await getTargetPhoneNumbers(db);
  const resolvedPhone = resolvePhoneFromJid(remoteJid);
  const rawId = remoteJid.split('@')[0].split(':')[0];

  console.log(`📩 [WhatsApp Received] From: ${remoteJid} (Phone: +${resolvedPhone}) | Message: "${text}"`);

  // Validate sender authorization
  const isAuthorized = targetNumbers.length === 0 || targetNumbers.some(target => {
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
  const isNo = /^(NO|N|REMOVE|FINISH|FINISHED|OUT\s+OF\s+STOCK|CLEAR)$/i.test(normalized) || normalized.startsWith('NO');
  const isYes = /^(YES|Y|KEEP|STILL\s+IN\s+STOCK|AVAILABLE|OW)$/i.test(normalized) || normalized.startsWith('YES');

  // Look up target batch from active alert context or query most critical batch
  let targetBatch = activeBatchAlerts.get(resolvedPhone) || activeBatchAlerts.get(rawId);

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

  const expDateStr = formatDateString(targetBatch.expiryDate);

  if (isNo) {
    // AUTOMATICALLY DELETE BATCH DOCUMENT FROM FIRESTORE
    try {
      await db.collection('stock_batches').doc(targetBatch.batchId).delete();
      console.log(`🗑️ [Batch Deleted] Successfully deleted batch ${targetBatch.batchId} (${targetBatch.itemName}) from Firestore.`);

      activeBatchAlerts.delete(resolvedPhone);
      activeBatchAlerts.delete(rawId);

      const replyText = `✅ *Removed from Active Tracking:*
*${targetBatch.itemName}* (Exp: ${expDateStr}) has been cleared from store stock batches.
No further expiry warnings will be sent. Master shelf QR code remains intact for future stock.`;

      await sock.sendMessage(remoteJid, { text: replyText });
    } catch (err) {
      console.error('❌ Error deleting batch document:', err);
    }
  } else if (isYes) {
    // KEEP BATCH ACTIVE
    activeBatchAlerts.delete(resolvedPhone);
    activeBatchAlerts.delete(rawId);

    const replyText = `👍 *Kept Active:*
*${targetBatch.itemName}* (Exp: ${expDateStr}) remains active in store tracking.
Next reminder will be sent as scheduled.`;

    await sock.sendMessage(remoteJid, { text: replyText });
  } else {
    // HELP PROMPT
    const replyText = `❓ Regarding: *${targetBatch.itemName}* (Exp: ${expDateStr})
Please reply:
• *YES* — to keep tracking this batch in store
• *NO* — to remove batch (stock finished)`;

    await sock.sendMessage(remoteJid, { text: replyText });
  }
}

/**
 * Daily Automated Expiry Audit (Triggered via cron at 08:00 AM Asia/Colombo)
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
    return { count: 0, message: 'No batches' };
  }

  let alertsDispatched = 0;

  for (const doc of snapshot.docs) {
    const batch = doc.data();
    const batchId = doc.id;
    const days = getDaysRemaining(batch.expiryDate);

    if (days === null) continue;

    // Check Milestones: 3m (90d), 2m (60d), 1m (30d), 14d, 7d, <=3d
    const milestone = getAlertMilestone(days, batch.lastAlertSent, isManual);

    if (milestone) {
      const expDateStr = formatDateString(batch.expiryDate);
      const milestoneDesc = getMilestoneDescription(milestone, days);

      const alertMessage = `⚠️ *EXPIRY ALERT (RATION STORE):*
📦 *${batch.itemName}*
⏳ Expiry Date: *${expDateStr}*
⏱️ Status: ${milestoneDesc}

Still in stock?
Reply *YES* to keep tracking, or *NO* to remove from stock.

_Ration Store Expiry Tracking System_`;

      if (connectionStatus === 'CONNECTED' && sock) {
        try {
          // Send to ALL configured target phone numbers
          for (const targetPhone of targetNumbers) {
            const targetJid = `${targetPhone}@s.whatsapp.net`;
            await sock.sendMessage(targetJid, { text: alertMessage });
            console.log(`📤 [Alert Sent] To +${targetPhone} for ${batch.itemName} (Milestone: ${milestone})`);

            // Save active context for reply handling (under both Phone and Privacy LID)
            const alertCtx = {
              batchId,
              itemName: batch.itemName,
              expiryDate: batch.expiryDate
            };
            activeBatchAlerts.set(targetPhone, alertCtx);
            const knownLid = getLidForPhone(targetPhone);
            if (knownLid) {
              activeBatchAlerts.set(knownLid, alertCtx);
            }
          }

          // Update Firestore batch document with last alerted milestone
          await db.collection('stock_batches').doc(batchId).update({
            lastAlertSent: milestone,
            lastAlertDate: new Date().toISOString()
          });

          alertsDispatched++;
        } catch (err) {
          console.error(`❌ Failed to send WhatsApp alert for batch ${batchId}:`, err.message);
        }
      } else {
        console.log(`⚠️ WhatsApp bot not connected. Alert queued for ${batch.itemName}`);
      }
    }
  }

  console.log(`🏁 [Audit Finished] Total alerts dispatched: ${alertsDispatched} (to ${targetNumbers.length} recipients)`);
  return { count: alertsDispatched, recipients: targetNumbers.length };
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
        <body style="font-family: sans-serif; background: #0b1120; color: #f8fafc; padding: 40px; text-align: center;">
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

  if (!latestQrDataUrl) {
    return res.send(`
      <!DOCTYPE html>
      <html>
        <head><title>Generating QR...</title><meta http-equiv="refresh" content="3"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
        <body style="font-family: sans-serif; background: #0b1120; color: #f8fafc; padding: 40px; text-align: center;">
          <h2>Generating WhatsApp QR Code...</h2>
          <p style="color: #94a3b8;">Please wait, auto-refreshing in 3 seconds...</p>
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
        <meta http-equiv="refresh" content="25">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0b1120; color: #f8fafc; padding: 25px; text-align: center; }
          .qr-box { max-width: 440px; margin: 0 auto; background: #1e293b; padding: 25px; border-radius: 16px; border: 1px solid #334155; }
          img { border-radius: 10px; background: white; padding: 10px; max-width: 100%; }
          ol { text-align: left; color: #94a3b8; font-size: 0.9rem; line-height: 1.6; }
        </style>
      </head>
      <body>
        <div class="qr-box">
          <h2 style="margin-top: 0;">📱 Link WhatsApp Device</h2>
          <img src="${latestQrDataUrl}" alt="WhatsApp QR Code" />
          <ol>
            <li>Open <strong>WhatsApp</strong> on your mobile phone.</li>
            <li>Tap <strong>Settings</strong> or <strong>Menu (3 dots)</strong> &rarr; <strong>Linked Devices</strong>.</li>
            <li>Tap <strong>Link a Device</strong> and point camera at this QR code.</li>
          </ol>
          <p style="font-size: 0.75rem; color: #64748b;">Page refreshes automatically. Zero API costs.</p>
        </div>
      </body>
    </html>
  `);
});

app.get('/api/status', (req, res) => {
  res.json({
    status: connectionStatus,
    botPhoneNumber,
    hasQr: Boolean(latestQrDataUrl)
  });
});

app.post('/api/logout', async (req, res) => {
  try {
    console.log(`🔄 [WhatsApp Logout] Changing/Unlinking current bot account (+${botPhoneNumber})...`);

    if (sock) {
      try {
        await sock.logout();
      } catch (e) {
        try { sock.end(); } catch (err) {}
      }
      sock = null;
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

    // 2. Wipe Firestore session backup
    const db = getDb();
    if (db) {
      await db.collection('whatsapp_session').doc('backup').delete().catch(() => {});
      console.log('🗑️ [Session] Firestore session backup cleared.');
    }

    // 3. Immediately reinitialize connection so new QR is generated
    setTimeout(connectToWhatsApp, 1500);

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
