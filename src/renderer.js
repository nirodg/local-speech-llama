function fmtBytes(n){ if(n==null) return '—'; const u=['B','KB','MB','GB']; let i=0,v=n; while(v>=1024&&i<u.length-1){v/=1024;i++;} return `${v.toFixed(v>=10||i===0?0:1)} ${u[i]}`; }
function esc(s){ return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }
function fmtTime(ms){ const s=Math.floor(ms/1000); const m=Math.floor(s/60); const ss=String(s%60).padStart(2,'0'); return `${String(m).padStart(2,'0')}:${ss}`; }

let state = null;
let audioPath = null;
let unlog = null, micUnlog = null;
let defaultsApplied = false;
let modelsInfo = null;
// mic
let mediaRecorder=null, micChunks=[], micStream=null, micStartAt=0, micTimerInt=null;
let micAudioCtx=null, micAnalyser=null, micLevelInt=null, micLastSpeaking=false;
function cleanupMicMonitor(){
  if(micLevelInt){ clearInterval(micLevelInt); micLevelInt=null; }
  if(micAudioCtx){ try{ micAudioCtx.close(); }catch(e){} micAudioCtx=null; }
  micAnalyser=null; micLastSpeaking=false;
}
function startMicMonitor(stream){
  cleanupMicMonitor();
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext; micAudioCtx = new Ctx();
    const src = micAudioCtx.createMediaStreamSource(stream); micAnalyser = micAudioCtx.createAnalyser(); micAnalyser.fftSize = 2048; src.connect(micAnalyser);
    const buf = new Uint8Array(micAnalyser.fftSize);
    micLevelInt = setInterval(()=>{
      if(!micAnalyser) return;
      micAnalyser.getByteTimeDomainData(buf); let sum=0; for(let i=0;i<buf.length;i++){ const v=(buf[i]-128)/128; sum+=v*v; } const rms = Math.sqrt(sum/buf.length);
      const speaking = rms > 0.02; micLastSpeaking = speaking;
      const level = Math.max(0.03, Math.min(1, rms * 8));
      try { window.offlineApi.sendListeningLevel({ level, speaking, source: 'mic' }); } catch {}
    }, 100);
  } catch(e){ appendMicLog(`\n[mic] level monitor unavailable: ${e.message}\n`); }
}


// live
let liveStream=null, liveRecorder=null, liveRunning=false, liveStopping=false, liveChunksDone=0, liveSeq=0, liveStartAt=0, liveTimerInt=null, liveQueue=[], liveProcessing=false, liveFullText='', liveChunkMs=6000, liveMode='fixed', liveAudioCtx=null, liveAnalyser=null, liveVadInt=null, liveSpeechSeen=false, liveLastVoiceAt=0, liveChunkStartedAt=0, liveStartedByHotkey=false, pendingHotkeyLive=false, liveSessionSpeechSeen=false, liveSessionLastVoiceAt=0, liveChunkSpeechSeen=false, liveAutoStopTriggered=false;

async function refresh(){
  try { modelsInfo = await window.offlineApi.getModels(); } catch (e) { console.error('getModels failed', e); }
  state = await window.offlineApi.getStatus();
  render();
}

function setRunStatus(msg, kind){ const el=document.getElementById('run-status'); if(el){el.textContent=msg; el.className='run-status '+(kind||'muted');} }
function appendLog(s){ const el=document.getElementById('log'); if(!el) return; if(el.textContent.startsWith('Ready.')) el.textContent=''; el.textContent += s; el.scrollTop = el.scrollHeight; }
function setMicStatus(msg, kind){ const el=document.getElementById('mic-status'); if(el){ el.textContent=msg; el.className='run-status '+(kind||'muted'); } }
function appendMicLog(s){ const el=document.getElementById('mic-log'); if(!el) return; if(el.textContent.startsWith('Ready')) el.textContent=''; el.textContent += s; el.scrollTop = el.scrollHeight; }
function setLiveStatus(msg, kind){ const el=document.getElementById('live-status'); if(el){ el.textContent=msg; el.className='run-status '+(kind||'muted'); } }
function appendLiveLog(s){ const el=document.getElementById('live-log'); if(!el) return; if(el.textContent.startsWith('Ready')) el.textContent=''; el.textContent += s; el.scrollTop = el.scrollHeight; }
function appendServerLog(s){ const el=document.getElementById('server-log'); if(!el) return; if(el.textContent.startsWith('Server log')) el.textContent=''; el.textContent += s; el.scrollTop = el.scrollHeight; }
function appendOverlayLog(s){ const el=document.getElementById('overlay-log'); if(!el) return; el.textContent += s; el.scrollTop = el.scrollHeight; }
function showOverlay(title, message, opts={}){
  const overlay=document.getElementById('startup-overlay');
  const titleEl=document.getElementById('overlay-title');
  const msgEl=document.getElementById('overlay-message');
  const logEl=document.getElementById('overlay-log');
  const retryBtn=document.getElementById('overlay-retry-btn');
  const dismissBtn=document.getElementById('overlay-dismiss-btn');
  if(!overlay) return;
  overlay.classList.remove('hidden');
  if(titleEl) titleEl.textContent=title || 'Starting server';
  if(msgEl) msgEl.textContent=message || '';
  if(logEl && opts.clear) logEl.textContent='';
  if(retryBtn) retryBtn.classList.toggle('hidden', !opts.showRetry);
  if(dismissBtn) dismissBtn.classList.toggle('hidden', !opts.showDismiss);
}
function hideOverlay(){
  const overlay=document.getElementById('startup-overlay');
  if(overlay) overlay.classList.add('hidden');
}
let flashTimer=null;
function flash(msg){ let el=document.getElementById('toast'); if(!el){ el=document.createElement('div'); el.id='toast'; document.body.appendChild(el);} el.textContent=msg; el.className='toast show'; clearTimeout(flashTimer); flashTimer=setTimeout(()=>el.className='toast',1500); }

async function ensureModelsInfo(){
  if (modelsInfo && modelsInfo.catalog) return modelsInfo;
  try { modelsInfo = await window.offlineApi.getModels(); } catch (e) { console.error('getModels failed', e); }
  return modelsInfo;
}

function renderModels(){
  const sel = document.getElementById('model-select');
  const descEl = document.getElementById('model-desc');
  if (!sel) return;
  if (!modelsInfo || !modelsInfo.catalog) {
    ensureModelsInfo().then(() => { if (modelsInfo && modelsInfo.catalog) renderModels(); }).catch(()=>{});
    sel.innerHTML = '<option value="">Loading models…</option>';
    if (descEl) descEl.textContent = 'Loading available models…';
    return;
  }
  const current = modelsInfo.selectedId;
  const prev = sel.value;
  sel.innerHTML = (modelsInfo.catalog || []).map(m => {
    const cached = m.cached ? '✓ cached' : `↓ ${m.size}`;
    const label = `${m.label} · ${m.quantLabel} — ${m.tag} (${cached})`;
    return `<option value="${esc(m.id)}">${esc(label)}</option>`;
  }).join('');
  sel.value = (modelsInfo.catalog || []).some(m => m.id === (prev || current)) ? (prev && prev !== '' ? prev : current) : current;
  // if user hasn't manually changed selection, keep selected; if they had a different one selected keep it? better sync to current when not focused
  if (document.activeElement !== sel) sel.value = current;
  const chosen = (modelsInfo.catalog || []).find(m => m.id === sel.value) || (modelsInfo.catalog || []).find(m => m.id === current);
  if (descEl && chosen) {
    const cacheTxt = chosen.cached ? 'Downloaded/cached locally.' : `Not cached yet — will download on start (${chosen.size}).`;
    descEl.textContent = `${chosen.description} ${cacheTxt}${chosen.requiresRecent ? ' Requires a recent llama-server build.' : ''}`;
  }
}

function render(){
  const s = state || {}; const srv = s.server || {}; const cfg = s.config || {}; const setup = s.serverSetup || {};
  const running = !!srv.running;
  const busy = ['installing-binary','starting'].includes(setup.state);
  const hasServerError = !running && setup.state === 'error' && setup.error;

  // overlay during startup / errors
  if (busy) {
    showOverlay(
      setup.state === 'installing-binary' ? 'Installing llama-server' : 'Starting server',
      setup.message || 'Setting up llama-server…',
      { clear: false, showRetry: false, showDismiss: false }
    );
  } else if (hasServerError) {
    showOverlay('Server setup failed', setup.error, { clear: false, showRetry: true, showDismiss: true });
  } else {
    hideOverlay();
  }

  const serverPill = document.getElementById('server-pill');
  if (busy) {
    serverPill.textContent = setup.state === 'installing-binary' ? 'Server: installing…' : 'Server: starting…';
    serverPill.className = 'pill info';
  } else {
    serverPill.textContent = running ? `Server: running (${srv.baseUrl||''})` : 'Server: not running';
    serverPill.className = 'pill ' + (running ? 'ok' : 'info');
  }
  const modelNames = srv.models && (srv.models.data || srv.models.models) ? (srv.models.data||srv.models.models).map(m=>m.id||m.name||m.model).filter(Boolean).join(', ') : '—';
  const selected = (srv.selectedModel) || (modelsInfo && (modelsInfo.catalog||[]).find(m=>m.id===modelsInfo.selectedId)) || null;
  const targetModelTxt = selected ? `${selected.label} ${selected.quantLabel} (${selected.tag}) — ${selected.hf}` : (srv.model || '—');
  const startBtn = document.getElementById('start-server-btn');
  const stopBtn = document.getElementById('stop-server-btn');
  const installBtn = document.getElementById('install-server-btn');
  if (startBtn) { startBtn.disabled = !!busy; startBtn.textContent = running ? 'Restart / ensure' : (setup.state === 'error' ? 'Retry setup' : 'Start / retry'); }
  if (stopBtn) { stopBtn.disabled = !srv.managed || !!busy; }
  if (installBtn) { installBtn.disabled = !!busy; installBtn.textContent = (s.managedLlamaBin && s.managedLlamaBin.installed) ? 'Update llama-server' : 'Install llama-server'; }
  const msgEl = document.getElementById('server-msg');
  if (msgEl && busy && setup.message) msgEl.textContent = setup.message;
  else if (msgEl && !busy && setup.state === 'error' && setup.error) msgEl.textContent = `Setup error: ${setup.error}`;
  else if (msgEl && running && setup.state === 'ready' && setup.message && !msgEl.textContent.startsWith('Setup error')) { /* keep informative messages from actions */ }
  const managedBin = s.managedLlamaBin || {};
  const rows = [
    ['llama-server binary', s.llamaServerBin || 'not found'],
    ['Managed llama-server', managedBin.installed ? `installed (${managedBin.path || 'userData/bin'})` : 'not installed (use "Install llama-server")'],
    ['Server status', running ? 'running' : 'not running'],
    ['Server URL', srv.baseUrl || '—'],
    ['Managed by app', srv.managed ? `yes${srv.pid?` (pid ${srv.pid})`:''}` : (srv.external ? 'no (external server in use)' : 'no (not started)')],
    ['Selected model (managed)', targetModelTxt],
    ['Loaded/available models', modelNames],
    ['ffmpeg', s.ffmpeg || 'not found (mic/webm conversion may be limited)'],
    ['Platform', (s.platform||'') + ' ' + (s.arch||'')],
    ['App version', s.version || '—'],
  ];
  document.getElementById('status').innerHTML = rows.map(([k,v])=>`<div>${k}</div><div>${esc(v ?? '')}</div>`).join('');
  const urlInput = document.getElementById('llama-url'); if(urlInput && document.activeElement !== urlInput) urlInput.value = cfg.llamaServerUrl || '';
  const backendSel = document.getElementById('asr-backend'); if(backendSel && document.activeElement !== backendSel) backendSel.value = cfg.asrBackend || 'managed-llama';
  renderModels();
  const serverTxt = running ? (srv.baseUrl || 'running') : 'not running';
  for(const id of ['live-server','mic-server','file-server']){ const el=document.getElementById(id); if(el) el.textContent = serverTxt; }

  // Disable transcription tabs/actions when no server is available
  const serverNote = running ? '' : 'Server not running — start the server from Overview to use this feature.';
  for(const id of ['live-status','mic-status','run-status']){ const el=document.getElementById(id); if(el && !running && serverNote) { el.textContent=serverNote; el.className='run-status muted'; } }
  const liveStartBtn=document.getElementById('live-start-btn'); if(liveStartBtn) liveStartBtn.disabled=!running;
  const micRecBtn=document.getElementById('mic-record-btn'); if(micRecBtn) micRecBtn.disabled=!running;
  const fileRunBtn=document.getElementById('run-btn'); if(fileRunBtn) fileRunBtn.disabled=!running;
  const filePickBtn=document.getElementById('pick-audio-btn'); if(filePickBtn) filePickBtn.disabled=!running;
  // dim the nav tabs that require a running server
  for(const nav of document.querySelectorAll('.nav-item[data-nav]')){
    const name=nav.getAttribute('data-nav');
    if(['live','mic','file'].includes(name)) nav.classList.toggle('tab-locked', !running);
  }
  const autoCopy = document.getElementById('auto-copy'); if(autoCopy) autoCopy.checked = !!cfg.autoCopy;
  const autoPaste = document.getElementById('auto-paste'); if(autoPaste) autoPaste.checked = !!cfg.autoPaste;
  const defaultLangSel = document.getElementById('default-language'); if(defaultLangSel && document.activeElement !== defaultLangSel) defaultLangSel.value = cfg.defaultLanguage || 'en';
  const autoStopInput = document.getElementById('auto-stop-seconds'); if(autoStopInput && document.activeElement !== autoStopInput) autoStopInput.value = String(cfg.autoStopSeconds ?? 3);
  const autoStartEl = document.getElementById('auto-start'); if(autoStartEl) autoStartEl.checked = !!cfg.autoStart;
  if (!defaultsApplied) {
    const dl = cfg.defaultLanguage || 'en';
    ['live-lang','mic-lang','lang'].forEach(id => { const el = document.getElementById(id); if (el) el.value = dl; });
    defaultsApplied = true;
  }
  const hkEnabled = document.getElementById('hotkey-enabled'); if(hkEnabled) hkEnabled.checked = !!cfg.globalHotkeyEnabled;
  const hkAccel = document.getElementById('hotkey-accel'); if(hkAccel && document.activeElement !== hkAccel) hkAccel.value = cfg.globalHotkey || 'CommandOrControl+Alt+Space';
  const hkStatus = document.getElementById('hotkey-status');
  if (hkStatus) {
    const hr = s.hotkey || {};
    if (!cfg.globalHotkeyEnabled) {
      hkStatus.textContent = 'Disabled';
    } else if (hr.registered) {
      hkStatus.textContent = `Active: ${hr.accelerator || cfg.globalHotkey || ''}`;
    } else {
      hkStatus.textContent = `Not active: ${hr.error || 'failed to register'} (${cfg.globalHotkey || ''})`;
    }
  }
  if (srv.logTail) { const sl=document.getElementById('server-log'); if(sl && sl.textContent.startsWith('Server log')) sl.textContent = srv.logTail; }
  renderHistory(s.history || []);
}

function renderHistory(items){
  const el = document.getElementById('history-list'); if(!el) return;
  if(!items.length){ el.innerHTML = '<div class="empty">No transcription history yet.</div>'; return; }
  el.innerHTML = items.map(h=>`<div class="hrow">
    <div class="hmeta"><span class="tag ${h.source==='mic'?'alt':'alt2'}">${esc(h.source||'')}</span> <span class="muted mono">${esc((h.at||'').replace('T',' ').replace('Z',''))}</span> ${h.ms?`<span class="muted">· ${h.ms} ms</span>`:''}</div>
    <div class="htext">${esc(h.transcript||'')}</div>
    <div class="row-actions"><button data-copy-h="${esc(h.id)}">Copy</button><button class="secondary" data-del-h="${esc(h.id)}">Delete</button></div>
  </div>`).join('');
  document.querySelectorAll('[data-copy-h]').forEach(b=>b.addEventListener('click', async (e)=>{ const id=e.currentTarget.getAttribute('data-copy-h'); const item=(state.history||[]).find(x=>x.id===id); if(item){ await window.offlineApi.copyText(item.transcript||''); flash('Copied'); } }));
  document.querySelectorAll('[data-del-h]').forEach(b=>b.addEventListener('click', async (e)=>{ const id=e.currentTarget.getAttribute('data-del-h'); const r=await window.offlineApi.deleteHistoryItem(id); state=r; render(); }));
}

// global log piping (server start/download/install logs go to the server log).
// Per-transcription handlers below subscribe for file/mic/live logs to avoid duplication.
window.offlineApi.onTranscribeLog && window.offlineApi.onTranscribeLog((line)=>{
  appendServerLog(line);
  appendOverlayLog(line);
});

// server controls
document.getElementById('overlay-retry-btn').addEventListener('click', async ()=>{
  document.getElementById('overlay-log').textContent='';
  document.getElementById('start-server-btn').click();
});
document.getElementById('overlay-dismiss-btn').addEventListener('click', ()=>{ hideOverlay(); });
document.getElementById('refresh-btn').addEventListener('click', ()=>{ refresh(); flash('Refreshed'); });
document.getElementById('start-server-btn').addEventListener('click', async ()=>{
  const msg=document.getElementById('server-msg'); if(msg) msg.textContent='Ensuring llama-server (may install binary and download model if needed)…';
  document.getElementById('server-log').textContent='';
  try {
    const r = await window.offlineApi.ensureLlamaServer();
    if(r && r.models) modelsInfo = r.models;
    if(r && r.status) state=r.status; else await refresh();
    render();
    if(msg) msg.textContent = r && r.ok ? `llama-server ready at ${r.baseUrl||''}` : `Setup: ${r && r.error ? r.error : 'not ready yet'} (check server log)`;
  } catch (e) {
    console.error(e);
    if(msg) msg.textContent = `Setup error: ${e && e.message ? e.message : e}`;
    flash('Setup failed');
  }
});
document.getElementById('stop-server-btn').addEventListener('click', async ()=>{
  const msg=document.getElementById('server-msg');
  try {
    const r = await window.offlineApi.stopLlamaServer(); if(r && r.status) state=r.status; else await refresh(); render();
    if(msg) msg.textContent='Managed llama-server stop requested.';
  } catch (e) {
    console.error(e);
    if(msg) msg.textContent = `Stop error: ${e && e.message ? e.message : e}`;
    flash('Stop failed');
  }
});
const installServerBtn = document.getElementById('install-server-btn');
if (installServerBtn) installServerBtn.addEventListener('click', async ()=>{
  const msg=document.getElementById('server-msg');
  document.getElementById('server-log').textContent='';
  if(msg) msg.textContent='Downloading and installing a managed llama-server (Linux x64)…';
  installServerBtn.disabled = true;
  try {
    const r = await window.offlineApi.installLlamaServer();
    if (r && r.status) state = r.status; else await refresh();
    render();
    if (r && r.ok) { if(msg) msg.textContent = `Managed llama-server installed${r.tag ? ' ('+r.tag+')' : ''}. You can now start/check the server.`; flash('llama-server installed'); }
    else { if(msg) msg.textContent = `Install failed: ${r && r.error ? r.error : 'unknown error'}`; flash(r && r.error ? r.error : 'Install failed'); }
  } catch (e) {
    console.error(e);
    if(msg) msg.textContent = `Install error: ${e && e.message ? e.message : e}`;
    flash('Install failed');
  } finally {
    installServerBtn.disabled = false;
  }
});
document.getElementById('save-url-btn').addEventListener('click', async ()=>{
  const url = (document.getElementById('llama-url').value||'').trim();
  state = await window.offlineApi.setLlamaUrl(url); render(); flash(url ? 'Server URL saved' : 'Server URL cleared');
});
document.getElementById('asr-backend').addEventListener('change', async (e)=>{
  const backend = e.target.value;
  if (backend === 'colibri' && !(document.getElementById('llama-url').value||'').trim()) {
    document.getElementById('llama-url').value = 'http://127.0.0.1:8080';
    await window.offlineApi.setLlamaUrl('http://127.0.0.1:8080');
  }
  state = await window.offlineApi.setAsrBackend(backend); render(); flash(`ASR backend: ${backend}`);
});
const modelSel = document.getElementById('model-select');
if (modelSel) modelSel.addEventListener('change', ()=>{ renderModels(); });
const widgetToggleBtn = document.getElementById('widget-toggle-btn');
if (widgetToggleBtn) widgetToggleBtn.addEventListener('click', async ()=>{
  try { await window.offlineApi.showWidget(); flash('Widget shown'); }
  catch (e) { console.error(e); flash('Widget failed'); }
});
window.offlineApi.onWidgetToggleDictate && window.offlineApi.onWidgetToggleDictate(()=>{
  // toggle live dictation from the widget (same idea as the global hotkey)
  if (liveRunning) {
    const stopBtn=document.getElementById('live-stop-btn');
    if(stopBtn && !stopBtn.disabled) stopBtn.click();
  } else {
    if (window.activatePage) window.activatePage('live');
    const startBtn=document.getElementById('live-start-btn');
    if(startBtn && !startBtn.disabled) startBtn.click();
  }
});
window.offlineApi.onWidgetStopDictate && window.offlineApi.onWidgetStopDictate(()=>{
  if (liveRunning) {
    const stopBtn=document.getElementById('live-stop-btn');
    if(stopBtn && !stopBtn.disabled) stopBtn.click();
  }
});

const applyModelBtn = document.getElementById('apply-model-btn');
if (applyModelBtn) applyModelBtn.addEventListener('click', async ()=>{
  const sel = document.getElementById('model-select');
  const modelId = sel ? sel.value : null;
  if (!modelId) return;
  const msg=document.getElementById('server-msg');
  document.getElementById('server-log').textContent='';
  if(msg) msg.textContent='Applying model and (re)starting managed llama-server… first run may download the model.';
  applyModelBtn.disabled = true;
  try {
    const r = await window.offlineApi.setModel(modelId);
    if (r && r.models) modelsInfo = r.models; else { try { modelsInfo = await window.offlineApi.getModels(); } catch {} }
    if (r && r.status) state = r.status; else await refresh();
    render();
    if (r && r.ok) { if(msg) msg.textContent = `Model applied. llama-server running at ${r.baseUrl||''}`; flash('Model applied'); }
    else { if(msg) msg.textContent = `Model apply: ${r && r.error ? r.error : 'failed / not ready yet (check server log)'}`; flash(r && r.error ? r.error : 'Model apply failed'); }
  } catch (e) {
    console.error(e);
    if(msg) msg.textContent = `Model apply error: ${e && e.message ? e.message : e}`;
    flash('Model apply failed');
  } finally {
    applyModelBtn.disabled = false;
  }
});

// file transcription
document.getElementById('pick-audio-btn').addEventListener('click', async ()=>{
  const r = await window.offlineApi.pickAudio();
  if(!r.canceled){ audioPath = r.path; document.getElementById('audio-path').textContent = audioPath; setRunStatus('Audio selected. Ready to transcribe.', ''); }
});
document.getElementById('run-btn').addEventListener('click', async ()=>{
  if(!audioPath){ setRunStatus('Choose an audio file first.', 'err'); return; }
  document.getElementById('log').textContent=''; document.getElementById('transcript').textContent='(running…)'; setRunStatus('Transcribing via llama-server…', '');
  if(unlog) unlog(); unlog = window.offlineApi.onTranscribeLog(line => appendLog(line));
  const lang = document.getElementById('lang').value;
  const res = await window.offlineApi.transcribe({ audioPath, language: lang });
  if(unlog){ unlog(); unlog=null; }
  if(res.ok){ const extra=res.auto&&res.auto.pasted?' · pasted':(res.auto&&res.auto.copied?' · copied':''); setRunStatus(`Done in ${res.ms||'?'} ms${extra}.`, 'ok'); document.getElementById('transcript').textContent = res.transcript || '(no text)'; }
  else { setRunStatus(res.error || `Failed`, 'err'); document.getElementById('transcript').textContent = res.transcript || '(no transcript)'; if(res.error) appendLog(`\n[error] ${res.error}\n`); }
  if(res.status) state=res.status; render();
});

// mic
const recBtn = document.getElementById('mic-record-btn');
const stopBtn = document.getElementById('mic-stop-btn');
recBtn.addEventListener('click', async ()=>{
  try { micStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch(e){ setMicStatus('Microphone unavailable: '+e.message, 'err'); appendMicLog('\n[error] '+e.message+'\n'); return; }
  micChunks = [];
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : (MediaRecorder.isTypeSupported('audio/webm')?'audio/webm':'');
  mediaRecorder = new MediaRecorder(micStream, mime?{mimeType:mime}:undefined);
  startMicMonitor(micStream);
  try { window.offlineApi.setListeningState({ active: true, label: 'Recording', sub: 'Microphone active', source: 'mic' }); } catch {}
  mediaRecorder.ondataavailable = e => { if(e.data && e.data.size) micChunks.push(e.data); };
  mediaRecorder.onstop = async ()=>{
    clearInterval(micTimerInt); micTimerInt=null;
    cleanupMicMonitor();
    try { window.offlineApi.setListeningState({ active: false }); } catch {}
    const blob = new Blob(micChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
    const buf = await blob.arrayBuffer();
    if (micStream) { try { micStream.getTracks().forEach(t=>t.stop()); } catch {} micStream=null; }
    document.getElementById('mic-state').textContent='processing…';
    setMicStatus(`Recorded ${fmtBytes(buf.byteLength)}. Transcribing via llama-server…`, '');
    document.getElementById('mic-log').textContent=''; document.getElementById('mic-transcript').textContent='(transcribing…)';
    if(micUnlog) micUnlog(); micUnlog = window.offlineApi.onTranscribeLog(line => appendMicLog(line));
    const lang = document.getElementById('mic-lang').value;
    const res = await window.offlineApi.transcribeMic({ buffer: buf, mimeType: blob.type || 'audio/webm', language: lang });
    if(micUnlog){ micUnlog(); micUnlog=null; }
    if(res.saved && res.saved.finalPath) document.getElementById('mic-file').textContent = res.saved.finalPath;
    if(res.ok){ const extra=res.auto&&res.auto.pasted?' · pasted':(res.auto&&res.auto.copied?' · copied':''); setMicStatus(`Done in ${res.ms||'?'} ms${extra}.`, 'ok'); document.getElementById('mic-transcript').textContent = res.transcript || '(no text)'; }
    else { setMicStatus(res.error || 'Failed', 'err'); document.getElementById('mic-transcript').textContent = res.transcript || '(no transcript)'; }
    document.getElementById('mic-state').textContent='idle'; recBtn.disabled=false; stopBtn.disabled=true;
    if(res.status) state=res.status; render();
  };
  mediaRecorder.start(250); micStartAt=Date.now();
  document.getElementById('mic-state').textContent='recording'; setMicStatus('Recording…', '');
  appendMicLog('\n[mic] recording started\n'); recBtn.disabled=true; stopBtn.disabled=false;
  micTimerInt=setInterval(()=>{ document.getElementById('mic-timer').textContent = fmtTime(Date.now()-micStartAt); }, 200);
});
stopBtn.addEventListener('click', ()=>{ if(mediaRecorder && mediaRecorder.state!=='inactive'){ try { window.offlineApi.setListeningState({ active: false }); } catch {} cleanupMicMonitor(); mediaRecorder.stop(); document.getElementById('mic-state').textContent='stopping…'; } });

// live
function cleanupLiveAudio(){ if(liveVadInt){ clearInterval(liveVadInt); liveVadInt=null; } if(liveAudioCtx){ try{ liveAudioCtx.close(); }catch(e){} liveAudioCtx=null; } liveAnalyser=null; liveSpeechSeen=false; liveLastVoiceAt=0; liveSessionSpeechSeen=false; liveSessionLastVoiceAt=0; liveChunkSpeechSeen=false; liveAutoStopTriggered=false; const v=document.getElementById('live-vad'); if(v) v.textContent='VAD: —'; }
function startVadMonitor(){
  cleanupLiveAudio();
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext; liveAudioCtx = new Ctx();
    const src = liveAudioCtx.createMediaStreamSource(liveStream); liveAnalyser = liveAudioCtx.createAnalyser(); liveAnalyser.fftSize = 2048; src.connect(liveAnalyser);
    const buf = new Uint8Array(liveAnalyser.fftSize);
    const now0 = Date.now();
    liveSpeechSeen=false; liveLastVoiceAt=now0;
    liveSessionSpeechSeen=false; liveSessionLastVoiceAt=now0; liveChunkSpeechSeen=false; liveAutoStopTriggered=false;
    liveVadInt = setInterval(()=>{
      if(!liveAnalyser || !liveRunning) return;
      liveAnalyser.getByteTimeDomainData(buf); let sum=0; for(let i=0;i<buf.length;i++){ const v=(buf[i]-128)/128; sum+=v*v; } const rms = Math.sqrt(sum/buf.length);
      const speaking = rms > 0.02; const now = Date.now();
      if(speaking){ liveSpeechSeen=true; liveChunkSpeechSeen=true; liveSessionSpeechSeen=true; liveLastVoiceAt=now; liveSessionLastVoiceAt=now; }
      const v=document.getElementById('live-vad'); if(v) v.textContent = speaking ? `VAD: speech (${rms.toFixed(3)})` : `VAD: silence (${rms.toFixed(3)})`;
      const level = Math.max(0.03, Math.min(1, rms * 8));
      try { window.offlineApi.sendListeningLevel({ level, speaking, source: 'live' }); } catch {}

      if(liveMode==='vad' && liveRecorder && liveRecorder.state==='recording'){
        const dur = now - liveChunkStartedAt; const silenceMs = now - liveLastVoiceAt;
        if(liveSpeechSeen && silenceMs > 800 && dur > 1500){ appendLiveLog(`\n[live] VAD cut (silence ${silenceMs}ms)\n`); try{ liveRecorder.stop(); }catch(e){} }
        else if(dur > 12000){ appendLiveLog(`\n[live] VAD max cut\n`); try{ liveRecorder.stop(); }catch(e){} }
        else if(!liveChunkSpeechSeen && dur > 8000){ appendLiveLog(`\n[live] VAD no-speech cut\n`); try{ liveRecorder.stop(); }catch(e){} }
      }

      if (!liveAutoStopTriggered && liveRunning && !liveStopping) {
        const cfg = (state && state.config) || {};
        const stopSec = Math.max(1, Number(cfg.autoStopSeconds) || 3);
        const stopMs = stopSec * 1000;
        const sessionSilenceMs = now - (liveSessionSpeechSeen ? liveSessionLastVoiceAt : liveStartAt);
        const stopAfterSpeech = liveSessionSpeechSeen && sessionSilenceMs >= stopMs;
        const stopNoSpeech = !liveSessionSpeechSeen && (now - liveStartAt) >= Math.max(stopMs + 2000, 6000);
        if (stopAfterSpeech || stopNoSpeech) {
          liveAutoStopTriggered = true;
          const reason = stopAfterSpeech ? `silence detected (${stopSec}s)` : 'no speech detected';
          appendLiveLog(`\n[live] auto-stop: ${reason}\n`);
          flash(stopAfterSpeech ? `Auto-stopped after ${stopSec}s silence` : 'Auto-stopped (no speech)');
          setLiveStatus(stopAfterSpeech ? `Silence detected (${stopSec}s) — stopping…` : 'No speech detected — stopping…', '');
          if (liveStopBtn && !liveStopBtn.disabled) liveStopBtn.click();
        }
      }
    }, 120);
  } catch(e){ appendLiveLog(`\n[live] VAD unavailable: ${e.message}\n`); }
}
async function processLiveQueue(){
  if(liveProcessing) return; liveProcessing=true;
  while(liveQueue.length){
    const job = liveQueue.shift();
    setLiveStatus(`Transcribing chunk #${job.seq}… (${liveQueue.length} queued)`, ''); document.getElementById('live-state').textContent='transcribing';
    try {
      const res = await window.offlineApi.transcribeLiveChunk({ buffer: job.buf, mimeType: job.type, language: job.language, seq: job.seq });
      if(res.ok && (res.transcript||'').trim()){ liveFullText = (liveFullText ? liveFullText + '\n' : '') + res.transcript.trim(); document.getElementById('live-transcript').textContent = liveFullText; }
      else if(!res.ok){ appendLiveLog(`\n[live#${job.seq} error] ${res.error||('exit '+res.code)}\n`); }
    } catch(e){ appendLiveLog(`\n[live#${job.seq} exception] ${e}\n`); }
    liveChunksDone++; document.getElementById('live-chunks').textContent = String(liveChunksDone);
  }
  liveProcessing=false;
  if(liveRunning && !liveStopping){ document.getElementById('live-state').textContent='recording'; const stopSec = Math.max(1, Number(((state && state.config) || {}).autoStopSeconds) || 3); const modeNote = liveMode==='vad' ? 'auto chunking on silence' : `chunked every ${Math.round(liveChunkMs/1000)}s`; setLiveStatus(`Listening… ${modeNote}. Auto-stops after ${stopSec}s of silence.`, ''); }
  else if(!liveRunning && liveQueue.length===0){
    if(liveStream){ try{ liveStream.getTracks().forEach(t=>t.stop()); }catch(e){} liveStream=null; } liveStopping=false;
    try { window.offlineApi.setListeningState({ active: false }); } catch {}
    document.getElementById('live-state').textContent='idle';
    const finalText = liveFullText.trim();
    if(finalText){
      const lang = document.getElementById('live-lang').value; const ms = Date.now()-liveStartAt;
      const forcePaste = !!liveStartedByHotkey;
      const r = await window.offlineApi.saveLiveHistory({ transcript: finalText, language: lang, ms, forcePaste });
      const extra = r && r.auto && r.auto.pasted ? ' · pasted' : (r && r.auto && r.auto.copied ? ' · copied' : '');
      setLiveStatus(`Stopped. ${liveChunksDone} chunk(s). Saved${extra}.`, 'ok');
      if(r && r.status){ state=r.status; render(); } else refresh();
    } else { setLiveStatus(`Stopped. ${liveChunksDone} chunk(s), no text.`, ''); }
    liveStartedByHotkey = false;
  }
}
function startLiveChunk(){
  if(!liveRunning || !liveStream) return;
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : (MediaRecorder.isTypeSupported('audio/webm')?'audio/webm':'');
  const rec = new MediaRecorder(liveStream, mime?{mimeType:mime}:undefined);
  liveRecorder = rec; let chunks=[]; liveChunkStartedAt = Date.now(); liveChunkSpeechSeen=false; liveSpeechSeen = liveSessionSpeechSeen; liveLastVoiceAt = liveSessionLastVoiceAt || Date.now();
  rec.ondataavailable = e=>{ if(e.data && e.data.size) chunks.push(e.data); };
  rec.onstop = async ()=>{
    if(!chunks.length){ if(liveRunning && !liveStopping) startLiveChunk(); else processLiveQueue(); return; }
    const blob = new Blob(chunks, { type: rec.mimeType||'audio/webm' }); const buf = await blob.arrayBuffer();
    const seq = ++liveSeq; const language = document.getElementById('live-lang').value;
    appendLiveLog(`\n[live] queued chunk #${seq} (${buf.byteLength} bytes)\n`);
    liveQueue.push({ buf, type: blob.type||'audio/webm', language, seq }); processLiveQueue();
    if(liveRunning && !liveStopping) startLiveChunk();
  };
  rec.start();
  if(liveMode!=='vad'){ setTimeout(()=>{ if(rec===liveRecorder && rec.state!=='inactive') try{ rec.stop(); }catch(e){} }, liveChunkMs); }
}
const liveStartBtn = document.getElementById('live-start-btn');
const liveStopBtn = document.getElementById('live-stop-btn');
liveStartBtn.addEventListener('click', async ()=>{
  const startedByHotkey = pendingHotkeyLive;
  pendingHotkeyLive = false;
  liveStartedByHotkey = !!startedByHotkey;
  await refresh();
  try { liveStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch(e){
    setLiveStatus('Microphone unavailable: '+e.message, 'err');
    appendLiveLog('\n[error] '+e.message+'\n');
    liveStartedByHotkey = false;
    return;
  }
  liveRunning=true; liveStopping=false; liveChunksDone=0; liveSeq=0; liveQueue=[]; liveProcessing=false; liveFullText='';
  liveSessionSpeechSeen=false; liveSessionLastVoiceAt=Date.now(); liveChunkSpeechSeen=false; liveAutoStopTriggered=false;
  const sel = document.getElementById('live-chunk-sec').value; liveMode = (sel==='vad') ? 'vad' : 'fixed'; liveChunkMs = (liveMode==='vad') ? 12000 : Math.max(3, parseInt(sel||'6',10)) * 1000;
  document.getElementById('live-log').textContent=''; document.getElementById('live-transcript').textContent='(listening…)'; document.getElementById('live-chunks').textContent='0'; document.getElementById('live-state').textContent='recording';
  const stopSec = Math.max(1, Number(((state && state.config) || {}).autoStopSeconds) || 3);
  const modeNote = liveMode==='vad' ? 'auto chunking on silence' : `chunked every ${Math.round(liveChunkMs/1000)}s`;
  setLiveStatus(`Listening… ${modeNote}. Auto-stops after ${stopSec}s of silence.`, ''); appendLiveLog(`[live] started${liveStartedByHotkey ? ' (hotkey)' : ''}\n`);
  liveStartAt=Date.now(); document.getElementById('live-timer').textContent='00:00'; liveTimerInt=setInterval(()=>{ document.getElementById('live-timer').textContent = fmtTime(Date.now()-liveStartAt); }, 200);
  liveStartBtn.disabled=true; liveStopBtn.disabled=false; startVadMonitor(); startLiveChunk();
  try { window.offlineApi.setListeningState({ active: true, label: 'Live dictation', sub: 'Microphone active', source: 'live' }); } catch {}
});
liveStopBtn.addEventListener('click', ()=>{
  liveRunning=false; liveStopping=true; if(liveTimerInt){ clearInterval(liveTimerInt); liveTimerInt=null; }
  document.getElementById('live-state').textContent='stopping…'; setLiveStatus('Stopping… finishing current chunk.', ''); appendLiveLog('\n[live] stop requested\n');
  liveStartBtn.disabled=false; liveStopBtn.disabled=true; cleanupLiveAudio();
  try { window.offlineApi.setListeningState({ active: false }); } catch {}
  if(liveRecorder && liveRecorder.state!=='inactive'){ try{ liveRecorder.stop(); }catch(e){} } else { if(liveStream){ liveStream.getTracks().forEach(t=>t.stop()); liveStream=null; } processLiveQueue(); }
  setTimeout(()=>{ if(liveStream){ liveStream.getTracks().forEach(t=>t.stop()); liveStream=null; } }, 1500);
});

// copy/history/ux
document.getElementById('copy-mic-btn').addEventListener('click', async ()=>{ const t=document.getElementById('mic-transcript').textContent||''; if(t && !t.startsWith('(')) { await window.offlineApi.copyText(t); flash('Copied'); } });
document.getElementById('copy-file-btn').addEventListener('click', async ()=>{ const t=document.getElementById('transcript').textContent||''; if(t && !t.startsWith('(')) { await window.offlineApi.copyText(t); flash('Copied'); } });
document.getElementById('copy-live-btn').addEventListener('click', async ()=>{ const t=(document.getElementById('live-transcript').textContent||'').trim(); if(t && !t.startsWith('(')) { await window.offlineApi.copyText(t); flash('Copied'); } });
document.getElementById('auto-copy').addEventListener('change', async (e)=>{ await window.offlineApi.setAutoCopy(e.target.checked); flash(e.target.checked?'Auto-copy enabled':'Auto-copy disabled'); refresh(); });
document.getElementById('auto-paste').addEventListener('change', async (e)=>{ await window.offlineApi.setAutoPaste(e.target.checked); flash(e.target.checked?'Auto-paste enabled':'Auto-paste disabled'); refresh(); });
const defaultLangSelEl = document.getElementById('default-language');
if (defaultLangSelEl) defaultLangSelEl.addEventListener('change', async (e)=>{
  const v = e.target.value || 'en';
  state = await window.offlineApi.setDefaultLanguage(v);
  ['live-lang','mic-lang','lang'].forEach(id => { const el = document.getElementById(id); if (el) el.value = v; });
  render();
  flash(`Default language: ${v}`);
});
const autoStopInputEl = document.getElementById('auto-stop-seconds');
if (autoStopInputEl) autoStopInputEl.addEventListener('change', async (e)=>{
  const v = Math.max(1, Math.min(60, Math.round(Number(e.target.value) || 3)));
  e.target.value = String(v);
  state = await window.offlineApi.setAutoStopSeconds(v);
  render();
  flash(`Auto-stop: ${v}s silence`);
});
const autoStartEl = document.getElementById('auto-start');
if (autoStartEl) autoStartEl.addEventListener('change', async (e)=>{
  const r = await window.offlineApi.setAutoStart(e.target.checked);
  if (r && r.status) state = r.status; else state = await window.offlineApi.getStatus();
  render();
  if (r && r.ok === false && r.error) flash(r.error);
  else flash(e.target.checked ? 'Start at login enabled' : 'Start at login disabled');
});
window.offlineApi.onStatusChanged && window.offlineApi.onStatusChanged(async ()=>{ try { state = await window.offlineApi.getStatus(); render(); } catch {} });
document.getElementById('hotkey-apply-btn').addEventListener('click', async ()=>{
  const enabled = !!document.getElementById('hotkey-enabled').checked; const accelerator = (document.getElementById('hotkey-accel').value||'').trim();
  const r = await window.offlineApi.setGlobalHotkey({ enabled, accelerator });
  if(r && r.hotkey && r.hotkey.error) flash('Hotkey: '+r.hotkey.error); else flash(enabled?'Global hotkey applied':'Global hotkey disabled');
  if(r && r.status) { state=r.status; render(); } else refresh();
});
document.getElementById('clear-history-btn').addEventListener('click', async ()=>{ const r=await window.offlineApi.clearHistory(); state=r; render(); flash('History cleared'); });

document.addEventListener('keydown', async (e)=>{
  if(e.ctrlKey && e.shiftKey && e.code==='KeyM'){ e.preventDefault(); if(!stopBtn.disabled) stopBtn.click(); else if(!recBtn.disabled) recBtn.click(); }
  if(e.ctrlKey && e.shiftKey && e.code==='KeyK'){ e.preventDefault(); const t=document.getElementById('mic-transcript').textContent||''; if(t && !t.startsWith('(')) { await window.offlineApi.copyText(t); flash('Copied'); } }
});
window.offlineApi.onGlobalHotkeyToggle && window.offlineApi.onGlobalHotkeyToggle(()=>{
  if(!liveStopBtn.disabled) {
    flash('Global hotkey: stopping (will auto-paste)');
    liveStopBtn.click();
  } else if(!liveStartBtn.disabled) {
    pendingHotkeyLive = true;
    flash('Global hotkey: starting (will auto-paste on stop)');
    liveStartBtn.click();
  } else {
    pendingHotkeyLive = false;
    flash('Global hotkey pressed');
  }
});

refresh().catch(e=>{ document.getElementById('status').textContent = 'Error: '+e; });

// window controls
const winMinBtn = document.getElementById('win-minimize'); if (winMinBtn) winMinBtn.addEventListener('click', () => { try { window.offlineApi.windowMinimize(); } catch {} });
const winCloseBtn = document.getElementById('win-close'); if (winCloseBtn) winCloseBtn.addEventListener('click', () => { try { window.offlineApi.windowClose(); } catch {} });

// --- UI navigation (full redesign shell) ---
(function initNavigation(){
  const navItems = Array.from(document.querySelectorAll('.nav-item[data-nav]'));
  const pages = Array.from(document.querySelectorAll('.page[data-page]'));
  const title = document.getElementById('page-title');
  const subtitle = document.getElementById('page-subtitle');
  const meta = {
    overview: ['Overview', 'Server status, model, and quick controls'],
    live: ['Live Dictation', 'Near-realtime chunked transcription'],
    mic: ['Microphone', 'Record and transcribe a single take'],
    file: ['Audio File', 'Transcribe a local audio file'],
    history: ['History & Settings', 'Clipboard, hotkey, and saved transcripts'],
  };
  function activate(name){
    navItems.forEach(b => b.classList.toggle('active', b.getAttribute('data-nav') === name));
    pages.forEach(p => p.classList.toggle('active', p.getAttribute('data-page') === name));
    if (meta[name]) {
      if (title) title.textContent = meta[name][0];
      if (subtitle) subtitle.textContent = meta[name][1];
    }
    try { localStorage.setItem('local-stt-ui-page', name); } catch {}
  }
  window.activatePage = activate;
  navItems.forEach(b => b.addEventListener('click', () => activate(b.getAttribute('data-nav'))));
  let initial = 'overview';
  try { initial = localStorage.getItem('local-stt-ui-page') || 'overview'; } catch {}
  if (!pages.some(p => p.getAttribute('data-page') === initial)) initial = 'overview';
  activate(initial);
})();
