function renderProcurementPage({ connectionStatus, botPhoneNumber, targets, demands, WORKFLOW_STEPS }) {
  const activeDemands = [];
  const completedDemands = [];

  (demands || []).forEach(d => {
    if (d.isCompleted) {
      completedDemands.push(d);
    } else {
      activeDemands.push(d);
    }
  });

  const nowFormatted = new Date().toLocaleString('en-GB', {
    timeZone: 'Asia/Colombo',
    dateStyle: 'medium',
    timeStyle: 'short'
  });

  // 1. Build Active Demands HTML
  let activeDemandsHtml = '';
  if (activeDemands.length === 0) {
    activeDemandsHtml = `
      <div class="empty-state">
        <h3 style="color:#ffffff;">No active demands currently in progress</h3>
        <p style="margin-top:6px; color:#94a3b8;">Click <strong>"➕ Create Demand from Laptop"</strong> above or add a Demand in the Android App to test.</p>
      </div>`;
  } else {
    activeDemandsHtml = activeDemands.map(d => {
      const step = WORKFLOW_STEPS[d.currentStep - 1] || WORKFLOW_STEPS[0];
      const pct = Math.round(((d.currentStep - 1) / 22) * 100);
      const updatedTime = d.lastUpdatedDate ? new Date(d.lastUpdatedDate).toLocaleString('en-GB', { timeZone: 'Asia/Colombo' }) : '-';
      
      let historyHtml = '';
      if (d.history && d.history.length > 0) {
        const items = d.history.map(h => `
          <div class="history-item">
            ✓ <strong>Step ${h.stepIndex}:</strong> ${h.stepName} 
            <span style="color:#64748b;">(${h.completedAt}${h.completedBy ? ' by ' + h.completedBy : ''})</span>
          </div>`).join('');
        historyHtml = `
          <div id="hist_${d.id}" class="history-box" style="display:none;">
            <strong style="color:#cbd5e1;">Completed Steps History:</strong>
            <div style="margin-top:6px;">${items}</div>
          </div>`;
      }

      return `
        <div class="demand-card">
          <div class="card-head">
            <div>
              <span class="demand-pill">${d.demandNumber}</span>
              <div class="demand-topic">${d.topic}</div>
            </div>
            <div style="text-align:right;">
              <span class="stage-pill">Step ${d.currentStep} / 22 (${pct}%)</span>
              <div style="font-size:0.75rem; color:#94a3b8; margin-top:4px;">${step.category}</div>
            </div>
          </div>
          
          <div class="progress-bar-bg">
            <div class="progress-bar-fill" style="width: ${Math.max(pct, 4)}%;"></div>
          </div>

          <div class="stage-box">
            <div style="font-size:0.78rem; text-transform:uppercase; color:#818cf8; font-weight:bold;">Current Stage Action (Awaiting Officer WhatsApp Verification):</div>
            <div class="stage-question">👉 ${step.text}</div>
            <div class="stage-hint">Reply <strong>YES</strong> to advance to Step ${Math.min(d.currentStep + 1, 22)}, or <strong>NO</strong> to stay at Step ${d.currentStep}.</div>
          </div>

          <div style="display:flex; justify-content:space-between; align-items:center; font-size:0.75rem; color:#64748b; margin-top:4px;">
            <span>Updated: ${updatedTime}</span>
            ${d.history && d.history.length > 0 ? `<span style="cursor:pointer; color:#818cf8; text-decoration:underline;" onclick="toggleHistory('${d.id}')">View History (${d.history.length} completed)</span>` : '<span>Step 1 Pending</span>'}
          </div>
          ${historyHtml}
        </div>`;
    }).join('');
  }

  // 2. Build Completed Demands HTML
  let completedDemandsHtml = '';
  if (completedDemands.length > 0) {
    const items = completedDemands.map(d => `
      <div class="demand-card completed">
        <div class="card-head">
          <div>
            <span class="demand-pill" style="border-color:#059669; color:#6ee7b7;">${d.demandNumber}</span>
            <div class="demand-topic">${d.topic}</div>
          </div>
          <span class="stage-pill" style="background:#064e3b; color:#6ee7b7; border-color:#059669;">✅ COMPLETED (100%)</span>
        </div>
        <div style="font-size:0.82rem; color:#10b981; margin-top:4px;">
          All 22 Steps Finished! Bill successfully forwarded to HQ.
        </div>
      </div>`).join('');
    completedDemandsHtml = `
      <div class="section-title" style="margin-top:20px;">
        <span>Completed Files (${completedDemands.length})</span>
      </div>
      <div class="demands-list">${items}</div>`;
  }

  // 3. Build Steps Reference HTML
  const stepsRefHtml = (WORKFLOW_STEPS || []).map(s => `
    <div class="step-item">
      <strong style="color:#a78bfa;">Step ${s.step}:</strong> ${s.text}
      <div style="color:#64748b; font-size:0.75rem;">${s.title} (${s.category})</div>
    </div>`).join('');

  const targetListText = (targets && targets.length > 0) ? targets.map(t => '+' + t).join(', ') : 'Default Fallback';
  const botStatusBadge = connectionStatus === 'CONNECTED' 
    ? `<span class="badge badge-bot-online"><span class="pulse-dot"></span> Bot: CONNECTED (+${botPhoneNumber || ''})</span>`
    : `<span class="badge badge-bot-offline">Bot: ${connectionStatus || 'DISCONNECTED'}</span>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SLAF Sigiriya - Procurement 22-Step Workflow Monitor</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
    body { background-color: #0b1120; color: #f8fafc; padding: 16px; min-height: 100vh; }
    .container { max-width: 960px; margin: 0 auto; }
    
    .header { background: #1e293b; border: 1px solid #334155; border-radius: 14px; padding: 22px; text-align: center; margin-bottom: 16px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.3); }
    .header h3 { color: #818cf8; font-size: 0.85rem; letter-spacing: 2px; text-transform: uppercase; margin-bottom: 6px; font-weight: 800; }
    .header h1 { font-size: 1.55rem; color: #ffffff; margin-bottom: 6px; font-weight: 900; }
    .header .timestamp { color: #94a3b8; font-size: 0.82rem; }
    
    .badges-row { display: flex; justify-content: center; align-items: center; gap: 10px; margin-top: 12px; flex-wrap: wrap; }
    .badge { display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; border-radius: 20px; font-size: 0.8rem; font-weight: 700; }
    .badge-bot-online { background: #064e3b; color: #6ee7b7; border: 1px solid #059669; }
    .badge-bot-offline { background: #7f1d1d; color: #fca5a5; border: 1px solid #dc2626; }
    .badge-target { background: #1e1b4b; color: #c7d2fe; border: 1px solid #4338ca; }
    .pulse-dot { width: 8px; height: 8px; border-radius: 50%; background: #10b981; display: inline-block; animation: pulse 1.8s infinite; }
    @keyframes pulse { 0% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(1.2); } 100% { opacity: 1; transform: scale(1); } }

    .action-panel { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 16px; margin-bottom: 16px; display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: space-between; }
    .action-group { display: flex; gap: 8px; flex-wrap: wrap; }
    .btn { display: inline-flex; align-items: center; gap: 6px; padding: 9px 16px; border-radius: 8px; font-size: 0.88rem; font-weight: 700; cursor: pointer; text-decoration: none; border: none; transition: background 0.15s ease; color: white; }
    .btn-purple { background: #7c3aed; }
    .btn-purple:hover { background: #6d28d9; }
    .btn-emerald { background: #059669; }
    .btn-emerald:hover { background: #047857; }
    .btn-blue { background: #0284c7; }
    .btn-blue:hover { background: #0369a1; }
    .btn-secondary { background: #334155; color: #cbd5e1; }
    .btn-secondary:hover { background: #475569; }

    .metrics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin-bottom: 16px; }
    .metric-card { background: #1e293b; border-radius: 10px; padding: 14px; text-align: center; border: 1px solid #334155; }
    .metric-val { font-size: 1.8rem; font-weight: 900; margin-bottom: 2px; }
    .metric-label { font-size: 0.75rem; text-transform: uppercase; font-weight: 700; color: #94a3b8; }
    .c-purple { color: #a78bfa; }
    .c-amber { color: #f59e0b; }
    .c-emerald { color: #10b981; }

    .form-box { background: #0f172a; border: 1px dashed #6366f1; border-radius: 10px; padding: 16px; margin-bottom: 16px; display: none; }
    .form-box.show { display: block; }
    .form-box h4 { color: #818cf8; margin-bottom: 12px; font-size: 0.95rem; }
    .form-grid { display: grid; grid-template-columns: 1fr 2fr auto; gap: 10px; }
    .form-input { padding: 10px 14px; background: #1e293b; border: 1px solid #334155; border-radius: 8px; color: white; font-size: 0.9rem; outline: none; }
    .form-input:focus { border-color: #818cf8; }

    .section-title { font-size: 1.05rem; font-weight: 800; color: #e2e8f0; margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between; }
    .demands-list { display: flex; flex-direction: column; gap: 12px; margin-bottom: 24px; }
    .demand-card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 18px; border-left: 6px solid #8b5cf6; display: flex; flex-direction: column; gap: 10px; box-shadow: 0 2px 4px rgba(0,0,0,0.2); }
    .demand-card.completed { border-left-color: #10b981; opacity: 0.85; }
    
    .card-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; flex-wrap: wrap; }
    .demand-pill { background: #0f172a; color: #a78bfa; font-weight: 800; font-size: 0.85rem; padding: 4px 10px; border-radius: 6px; border: 1px solid #4338ca; }
    .demand-topic { font-size: 1.15rem; font-weight: 800; color: #ffffff; margin-top: 4px; }
    .stage-pill { font-size: 0.78rem; font-weight: 800; padding: 4px 10px; border-radius: 20px; background: #2e1065; color: #ddd6fe; border: 1px solid #7c3aed; }
    
    .progress-bar-bg { width: 100%; height: 8px; background: #334155; border-radius: 4px; overflow: hidden; margin: 4px 0; }
    .progress-bar-fill { height: 100%; background: linear-gradient(90deg, #8b5cf6, #06b6d4); border-radius: 4px; transition: width 0.3s ease; }
    
    .stage-box { background: #0f172a; border-radius: 8px; padding: 12px; border: 1px solid #1e293b; }
    .stage-question { font-size: 1rem; color: #38bdf8; font-weight: 700; margin-top: 4px; }
    .stage-hint { font-size: 0.8rem; color: #94a3b8; margin-top: 4px; }
    
    .history-box { margin-top: 8px; padding: 10px; background: #0f172a; border-radius: 8px; font-size: 0.8rem; color: #94a3b8; }
    .history-item { margin-bottom: 4px; padding-bottom: 4px; border-bottom: 1px solid #1e293b; }
    
    .steps-ref { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 16px; margin-top: 20px; }
    .steps-ref summary { font-weight: 800; color: #94a3b8; cursor: pointer; font-size: 0.95rem; }
    .steps-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 8px; margin-top: 14px; }
    .step-item { background: #0f172a; padding: 8px 12px; border-radius: 6px; font-size: 0.82rem; border-left: 3px solid #6366f1; }
    
    .empty-state { background: #1e293b; border: 1px dashed #334155; border-radius: 12px; padding: 30px; text-align: center; color: #94a3b8; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h3>SRI LANKA AIR FORCE • STATION SIGIRIYA</h3>
      <h1>📂 Procurement 22-Step Workflow Monitor</h1>
      <div class="timestamp">Live Sync with Cloud Firestore • As at: ${nowFormatted}</div>
      <div class="badges-row">
        ${botStatusBadge}
        <span class="badge badge-target">📲 Targets: ${targetListText}</span>
      </div>
    </div>

    <div class="action-panel">
      <div class="action-group">
        <button class="btn btn-purple" onclick="triggerAutoPrompt()">⚡ Test Auto-Prompt Now</button>
        <button class="btn btn-emerald" onclick="toggleCreateForm()">➕ Create Demand from Laptop</button>
      </div>
      <div class="action-group">
        <a class="btn btn-blue" href="/procurement">🔄 Refresh</a>
        <a class="btn btn-secondary" href="/">🏠 Main Bot</a>
        <a class="btn btn-secondary" href="/qr">📱 QR Scan</a>
      </div>
    </div>

    <div id="createFormBox" class="form-box">
      <h4>➕ Register New Demand File (Realtime Auto-Trigger Test)</h4>
      <div class="form-grid">
        <input id="newDemandNo" class="form-input" placeholder="Demand No (e.g. DEM/2026/012)" required />
        <input id="newTopic" class="form-input" placeholder="File Topic (e.g. Quotations for Station Vehicle Repair)" required />
        <button class="btn btn-emerald" onclick="submitCreateDemand()">Save & Auto-Trigger</button>
      </div>
      <p style="font-size:0.75rem; color:#94a3b8; margin-top:8px;">* Save කළ සැණින් Realtime Listener එක මඟින් Step 1 ප්‍රශ්නය ඔබේ WhatsApp වෙත ස්වයංක්‍රීයව එවනු ඇත.</p>
    </div>

    <div class="metrics-grid">
      <div class="metric-card">
        <div class="metric-val c-purple">${(demands || []).length}</div>
        <div class="metric-label">Total Files</div>
      </div>
      <div class="metric-card">
        <div class="metric-val c-amber">${activeDemands.length}</div>
        <div class="metric-label">In-Progress</div>
      </div>
      <div class="metric-card">
        <div class="metric-val c-emerald">${completedDemands.length}</div>
        <div class="metric-label">Completed</div>
      </div>
    </div>

    <div class="section-title">
      <span>Active Files in Progress (${activeDemands.length})</span>
      <span style="font-size:0.8rem; color:#94a3b8; font-weight:normal;">Auto-advances when officer replies YES</span>
    </div>

    <div class="demands-list">
      ${activeDemandsHtml}
    </div>

    ${completedDemandsHtml}

    <details class="steps-ref">
      <summary>📋 Click to view Full 22-Step Workflow Reference</summary>
      <div class="steps-grid">
        ${stepsRefHtml}
      </div>
    </details>
  </div>

  <script>
    function triggerAutoPrompt() {
      fetch('/api/procurement/check-now', { method: 'POST' })
        .then(r => r.json())
        .then(data => {
          if (data.success && data.result) {
            if (data.result.count > 0) {
              alert('✅ [Auto-Prompt Dispatched!]\\nDemand: ' + data.result.demandNumber + '\\nStep: ' + data.result.step + '/22\\nNotification sent to WhatsApp!');
              window.location.reload();
            } else {
              alert('ℹ️ Bot response: ' + (data.result.message || 'No pending prompts to send or bot offline.'));
            }
          } else {
            alert('❌ Failed: ' + (data.error || 'Unknown error'));
          }
        })
        .catch(e => alert('❌ Error: ' + e.message));
    }

    function toggleCreateForm() {
      const box = document.getElementById('createFormBox');
      box.classList.toggle('show');
    }

    function toggleHistory(id) {
      const box = document.getElementById('hist_' + id);
      if (box) box.style.display = box.style.display === 'none' ? 'block' : 'none';
    }

    function submitCreateDemand() {
      const demandNumber = document.getElementById('newDemandNo').value.trim();
      const topic = document.getElementById('newTopic').value.trim();
      if (!demandNumber || !topic) {
        alert('Please enter both Demand Number and File Topic.');
        return;
      }
      fetch('/api/procurement/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ demandNumber, topic })
      })
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          alert('✅ Demand Created Successfully!\\nFirestore saved: ' + data.demandNumber + '\\n\\n⚡ Real-time listener will send Step 1 notification to WhatsApp in 1-2 seconds!');
          window.location.reload();
        } else {
          alert('❌ Failed to create: ' + data.error);
        }
      })
      .catch(e => alert('❌ Error: ' + e.message));
    }
  </script>
</body>
</html>`;
}

module.exports = { renderProcurementPage };
