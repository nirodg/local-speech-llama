const { app, BrowserWindow, ipcMain, dialog, clipboard, globalShortcut, Tray, Menu, nativeImage, shell, screen } = require('electron');
app.setName('Local Speech');

const _hasNoSandbox = process.argv.includes('--no-sandbox') || app.commandLine.hasSwitch('no-sandbox');
const _hasDisableSandbox = process.argv.includes('--disable-setuid-sandbox') || app.commandLine.hasSwitch('disable-setuid-sandbox');
if (!_hasNoSandbox) {
  try { app.commandLine.appendSwitch('no-sandbox'); } catch {}
  try { app.commandLine.appendSwitch('disable-setuid-sandbox'); } catch {}
  try { app.commandLine.appendSwitch('disable-gpu'); } catch {}
  try { app.commandLine.appendSwitch('disable-dev-shm-usage'); } catch {}
  try { app.disableHardwareAcceleration(); } catch {}
  // In some environments sandbox mode is decided very early; if we're in the main process, relaunch once with flags.
  if (process.type === 'browser' && !process.env.LOCAL_SPEECH_RELAUNCHED) {
    try {
      const { spawn } = require('child_process');
      const args = process.argv.slice(1).filter(a => !['--no-sandbox','--disable-setuid-sandbox','--disable-gpu','--disable-dev-shm-usage'].includes(a));
      args.push('--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage');
      const child = spawn(process.execPath, args, {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, LOCAL_SPEECH_RELAUNCHED: '1' },
      });
      child.unref();
      app.exit(0);
    } catch {}
  }
}

const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { spawn, spawnSync, execSync } = require('child_process');
const { runTranscription } = require('./transcribe');

function findCmd(names) {
  for (const n of names) {
    try {
      const p = execSync(`command -v ${n}`, { encoding: 'utf8' }).trim();
      if (!p) continue;
      const abs = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
      try { return fs.realpathSync(abs); } catch { return abs; }
    } catch {}
  }
  return null;
}


function configPath() { return path.join(app.getPath('userData'), 'config.json'); }
function historyPath() { return path.join(app.getPath('userData'), 'history.json'); }
function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); return p; }

function loadConfig() {
  const defaults = { autoCopy: false, autoPaste: false, globalHotkeyEnabled: false, globalHotkey: 'CommandOrControl+Alt+Space', llamaServerUrl: '', defaultLanguage: 'en', autoStopSeconds: 3, autoStart: false };
  try {
    const c = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    return { ...defaults, ...c };
  } catch {
    return { ...defaults };
  }
}
function saveConfig(cfg) { fs.mkdirSync(path.dirname(configPath()), { recursive: true }); fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2)); }

function loadHistory() { try { const h = JSON.parse(fs.readFileSync(historyPath(), 'utf8')); return Array.isArray(h) ? h : []; } catch { return []; } }
function saveHistory(items) { fs.mkdirSync(path.dirname(historyPath()), { recursive: true }); fs.writeFileSync(historyPath(), JSON.stringify(items.slice(0, 200), null, 2)); }
function addHistory(entry) { const items = loadHistory(); items.unshift({ id: 'h-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7), at: new Date().toISOString(), ...entry }); saveHistory(items); return items; }

let mainWindow = null;
let tray = null;
let isQuitting = false;
let widgetWindow = null;
let listeningActive = false;
let registeredHotkey = null;
let hotkeyRegistration = { ok: false, registered: false, accelerator: null, error: null };
let managedLlama = { proc: null, port: 8178, startedByApp: false, bin: null, model: 'ggml-org/Qwen3-ASR-1.7B-GGUF', url: null, log: '', lastEnsure: null };
const SCAN_PORTS = [9931, 8080, 8178, 8081, 8082, 11434];

function httpGetJson(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const client = u.protocol === 'https:' ? https : http;
      const req = client.get(url, { timeout: timeoutMs }, (res) => {
        let data = ''; res.setEncoding('utf8');
        res.on('data', c => data += c);
        res.on('end', () => { let j = null; try { j = JSON.parse(data); } catch {} resolve({ ok: res.statusCode >= 200 && res.statusCode < 500, status: res.statusCode, json: j, text: data }); });
      });
      req.on('timeout', () => { try { req.destroy(); } catch {} resolve({ ok: false }); });
      req.on('error', () => resolve({ ok: false }));
    } catch { resolve({ ok: false }); }
  });
}

async function probeLlamaServer(baseUrl) {
  // llama-server typically has /health {"status":"ok"} and /v1/models
  const h = await httpGetJson(`${baseUrl.replace(/\/$/, '')}/health`, 1200);
  if (h.ok && h.json && (h.json.status === 'ok' || h.json.status === 'loading' || h.json.status === 'no slot available')) return { running: true, baseUrl, health: h.json };
  const m = await httpGetJson(`${baseUrl.replace(/\/$/, '')}/v1/models`, 1200);
  if (m.ok && m.json && (m.json.data || m.json.models || m.json.object)) return { running: true, baseUrl, models: m.json };
  return { running: false, baseUrl };
}

async function detectRunningLlamaServer() {
  const cfg = loadConfig();
  const candidates = [];
  if (cfg.llamaServerUrl) candidates.push(cfg.llamaServerUrl.trim());
  if (managedLlama.url) candidates.push(managedLlama.url);
  for (const p of SCAN_PORTS) candidates.push(`http://127.0.0.1:${p}`);
  const seen = new Set();
  for (const c of candidates) {
    if (!c) continue; const norm = c.replace(/\/$/, ''); if (seen.has(norm)) continue; seen.add(norm);
    const r = await probeLlamaServer(norm);
    if (r.running) return r;
  }
  return { running: false };
}

function findLlamaServerBin() {
  return findCmd(['llama-server']) || (fs.existsSync('/usr/local/lib/ollama/llama-server') ? '/usr/local/lib/ollama/llama-server' : null);
}

async function ensureManagedLlamaServer(onLine) {
  const bin = findLlamaServerBin();
  managedLlama.bin = bin;
  // if already running anywhere, use it
  const running = await detectRunningLlamaServer();
  if (running.running) {
    managedLlama.url = running.baseUrl;
    if (!(managedLlama.proc && !managedLlama.proc.killed && managedLlama.startedByApp)) managedLlama.startedByApp = false;
    return { ok: true, running: true, reused: true, baseUrl: running.baseUrl, bin, health: running.health || null };
  }
  if (managedLlama.proc && !managedLlama.proc.killed) {
    // wait for readiness
  } else {
    if (!bin) return { ok: false, running: false, error: 'llama-server binary not found (install llama.cpp / llama-server)', bin: null };
    const port = managedLlama.port;
    const args = ['-hf', managedLlama.model, '--host', '127.0.0.1', '--port', String(port)];
    onLine && onLine(`[llama-server] starting: ${bin} ${args.join(' ')}\n`);
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    managedLlama.proc = child; managedLlama.startedByApp = true; managedLlama.log = ''; managedLlama.url = `http://127.0.0.1:${port}`;
    child.stdout.on('data', d => { managedLlama.log = (managedLlama.log + d.toString()).slice(-6000); });
    child.stderr.on('data', d => { managedLlama.log = (managedLlama.log + d.toString()).slice(-6000); });
    child.on('exit', (code) => { if (managedLlama.proc === child) { managedLlama.proc = null; managedLlama.startedByApp = false; } managedLlama.lastExit = code; });
  }
  const baseUrl = `http://127.0.0.1:${managedLlama.port}`;
  const start = Date.now();
  const timeoutMs = 10 * 60 * 1000; // allow first-run model download
  while (Date.now() - start < timeoutMs) {
    const r = await probeLlamaServer(baseUrl);
    if (r.running) { managedLlama.url = baseUrl; return { ok: true, running: true, startedByApp: true, baseUrl, bin, pid: managedLlama.proc ? managedLlama.proc.pid : null }; }
    if (managedLlama.proc && managedLlama.proc.exitCode != null) break;
    await new Promise(res => setTimeout(res, 1000));
  }
  const r = await probeLlamaServer(baseUrl);
  return { ok: r.running, running: r.running, startedByApp: managedLlama.startedByApp, baseUrl, bin, pid: managedLlama.proc ? managedLlama.proc.pid : null, error: r.running ? null : 'llama-server not ready yet (it may still be downloading/loading the model)', logTail: managedLlama.log.slice(-1200) };
}

function stopManagedLlamaServer() {
  const p = managedLlama.proc;
  if (p && !p.killed) {
    try { p.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { if (!p.killed) p.kill('SIGKILL'); } catch {} }, 2000);
  }
  managedLlama.proc = null; managedLlama.startedByApp = false;
}

function pasteIntoActiveApp() {
  const isWayland = !!(process.env.WAYLAND_DISPLAY || (process.env.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland');
  const candidates = [];
  if (isWayland) {
    candidates.push({ cmd: 'wtype', args: ['-M', 'ctrl', '-k', 'v', '-m', 'ctrl'] });
    candidates.push({ cmd: 'ydotool', args: ['key', '29:1', '47:1', '47:0', '29:0'] });
  }
  candidates.push({ cmd: 'xdotool', args: ['key', '--clearmodifiers', 'ctrl+v'] });
  if (!isWayland) {
    candidates.push({ cmd: 'wtype', args: ['-M', 'ctrl', '-k', 'v', '-m', 'ctrl'] });
    candidates.push({ cmd: 'ydotool', args: ['key', '29:1', '47:1', '47:0', '29:0'] });
  }
  for (const c of candidates) {
    const bin = findCmd([c.cmd]);
    if (!bin) continue;
    const r = spawnSync(bin, c.args, { encoding: 'utf8' });
    if (r.status === 0) return { ok: true, method: c.cmd };
    return { ok: false, method: c.cmd, error: (r.stderr || r.stdout || `exit ${r.status}`).slice(-200) };
  }
  return { ok: false, error: 'No paste tool found (tried xdotool/wtype/ydotool). Transcript copied to clipboard.' };
}

function maybeAutoPaste(text, opts = {}) {
  const cfg = loadConfig();
  const forcePaste = !!opts.forcePaste;
  const shouldCopy = forcePaste || cfg.autoCopy || cfg.autoPaste;
  const shouldPaste = forcePaste || cfg.autoPaste;
  const res = { copied: false, pasted: false, detail: null, forced: forcePaste };
  if (shouldCopy && (text || '').trim()) { try { clipboard.writeText(text); res.copied = true; } catch (e) { res.detail = e.message; } }
  if (shouldPaste && (text || '').trim()) { const p = pasteIntoActiveApp(); res.pasted = !!p.ok; res.detail = p.ok ? `pasted via ${p.method}${forcePaste ? ' (hotkey)' : ''}` : (p.error || 'paste failed'); }
  return res;
}

function applyGlobalHotkey() {
  if (registeredHotkey) { try { globalShortcut.unregister(registeredHotkey); } catch {} registeredHotkey = null; }
  const cfg = loadConfig();
  if (!cfg.globalHotkeyEnabled) {
    hotkeyRegistration = { ok: true, registered: false, accelerator: cfg.globalHotkey || null, error: null };
    return hotkeyRegistration;
  }
  if (!cfg.globalHotkey) {
    hotkeyRegistration = { ok: false, registered: false, accelerator: null, error: 'No accelerator set' };
    return hotkeyRegistration;
  }
  try {
    const ok = globalShortcut.register(cfg.globalHotkey, () => {
      try { console.log('[hotkey] triggered', cfg.globalHotkey); } catch {}
      if (mainWindow && !mainWindow.isDestroyed()) { try { mainWindow.webContents.send('global-hotkey-toggle'); } catch {} }
    });
    if (ok) registeredHotkey = cfg.globalHotkey;
    hotkeyRegistration = { ok, registered: ok, accelerator: cfg.globalHotkey, error: ok ? null : 'Failed to register (in use, invalid, or unsupported on this platform/session)' };
    return hotkeyRegistration;
  } catch (e) {
    hotkeyRegistration = { ok: false, registered: false, accelerator: cfg.globalHotkey, error: e.message };
    return hotkeyRegistration;
  }
}

async function getStatus() {
  const cfg = loadConfig();
  const ffmpeg = findCmd(['ffmpeg']);
  const llamaServerBin = findLlamaServerBin();
  const running = await detectRunningLlamaServer();
  const baseUrl = running.running ? running.baseUrl : (managedLlama.proc && !managedLlama.proc.killed ? managedLlama.url : null);
  let models = null;
  if (baseUrl) { const m = await httpGetJson(`${baseUrl.replace(/\/$/, '')}/v1/models`, 1200); if (m.ok) models = m.json; }
  return {
    offline: false,
    ffmpeg,
    llamaServerBin,
    server: {
      running: !!running.running || !!(managedLlama.proc && !managedLlama.proc.killed),
      baseUrl: baseUrl || null,
      managed: managedLlama.startedByApp && !!managedLlama.proc,
      pid: managedLlama.proc ? managedLlama.proc.pid : null,
      model: managedLlama.model,
      models,
      logTail: managedLlama.log ? managedLlama.log.slice(-600) : '',
    },
    config: { ...cfg, autoStart: isAutoStartEnabled() },
    hotkey: hotkeyRegistration,
    history: loadHistory(),
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
  };
}

function saveMicRecording(buffer, mimeType) {
  const dir = ensureDir(path.join(app.getPath('userData'), 'recordings'));
  const ts = Date.now();
  const ext = (mimeType && mimeType.includes('wav')) ? 'wav' : (mimeType && mimeType.includes('ogg')) ? 'ogg' : 'webm';
  const rawPath = path.join(dir, `mic-${ts}.${ext}`);
  fs.writeFileSync(rawPath, Buffer.from(buffer));
  const wavPath = path.join(dir, `mic-${ts}.wav`);
  const ff = findCmd(['ffmpeg']);
  let finalPath = rawPath, converted = false, convErr = null;
  if (ff && ext !== 'wav') {
    const r = spawnSync(ff, ['-y', '-i', rawPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath], { encoding: 'utf8' });
    if (r.status === 0 && fs.existsSync(wavPath)) { finalPath = wavPath; converted = true; }
    else convErr = (r.stderr || r.stdout || 'ffmpeg conversion failed').slice(-400);
  } else if (ext === 'wav') { finalPath = rawPath; converted = true; }
  return { rawPath, finalPath, converted, convErr };
}

async function transcribeWithLlama(audioPath, language, sender) {
  const onLine = (line) => { try { sender && sender.send('transcribe-log', line); } catch {} };
  let running = await detectRunningLlamaServer();
  if (!running.running) {
    onLine('[llama-server] no running instance detected, starting managed llama-server...\n');
    const ensured = await ensureManagedLlamaServer(onLine);
    managedLlama.lastEnsure = ensured;
    running = await detectRunningLlamaServer();
  }
  if (!running.running) {
    return { ok: false, error: 'No llama-server running and failed to start one. Check llama-server binary and logs.', audioPath, logTail: managedLlama.log.slice(-1200) };
  }
  const baseUrl = running.baseUrl;
  onLine(`[llama-server] using ${baseUrl}\n`);
  const result = await runTranscription({ audioPath, language, baseUrl, onLine });
  return { ...result, audioPath, baseUrl };
}

function cleanupOldRecordings() {
  try {
    const base = path.join(app.getPath('userData'), 'recordings');
    for (const sub of ['live', '']) {
      const dir = sub ? path.join(base, sub) : base;
      if (!fs.existsSync(dir)) continue;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        try {
          if (ent.isDirectory()) fs.rmSync(full, { recursive: true, force: true });
          else fs.unlinkSync(full);
        } catch {}
      }
    }
  } catch (e) {
    console.error('[cleanup] recordings cleanup failed', e);
  }
}

function getAutoStartPath() {
  return path.join(app.getPath('home'), '.config', 'autostart', 'local-speech.desktop');
}

function getAutoStartExec() {
  if (process.env.APPIMAGE) return `"${process.env.APPIMAGE}" --no-sandbox --disable-gpu`;
  // packaged app (e.g. installed) - use process.execPath
  if (app.isPackaged) return `"${process.execPath}" --no-sandbox --disable-gpu`;
  return null;
}

function isAutoStartEnabled() {
  try { return fs.existsSync(getAutoStartPath()); } catch { return false; }
}

function setAutoStartEnabled(enabled) {
  const p = getAutoStartPath();
  try {
    if (!enabled) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
      return { ok: true, enabled: false };
    }
    const exec = getAutoStartExec();
    if (!exec) return { ok: false, enabled: false, error: 'Auto-start can only be enabled for installed/packaged builds (not from source).' };
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const iconPath = path.join(__dirname, '..', 'assets', 'icon-256.png');
    const desktop = `[Desktop Entry]
Type=Application
Name=Local Speech
Comment=Local speech-to-text
Exec=${exec}
Icon=${fs.existsSync(iconPath) ? iconPath : ''}
Terminal=false
X-GNOME-Autostart-enabled=true
StartupNotify=false
Categories=AudioVideo;Utility;
`;
    fs.writeFileSync(p, desktop, 'utf8');
    return { ok: true, enabled: true };
  } catch (e) {
    return { ok: false, enabled: isAutoStartEnabled(), error: e.message || String(e) };
  }
}

function resolveAsset(name) {
  const candidates = [
    path.join(__dirname, '..', 'assets', name),
    path.join(__dirname, 'assets', name),
    path.join(process.resourcesPath || '', 'assets', name),
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'assets', name),
  ];
  for (const p of candidates) { try { if (p && fs.existsSync(p)) return p; } catch {} }
  return null;
}

function getAppIcon() {
  try {
    const pngPath = resolveAsset('icon-256.png') || resolveAsset('icon.png');
    if (pngPath) {
      const img = nativeImage.createFromPath(pngPath);
      if (!img.isEmpty()) return img;
    }
    const svgPath = resolveAsset('icon.svg');
    if (svgPath) {
      const svg = fs.readFileSync(svgPath, 'utf8');
      const img = nativeImage.createFromDataURL('data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'));
      if (!img.isEmpty()) return img;
    }
  } catch (e) { console.error('[icon] load failed', e); }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect x="8" y="8" width="48" height="48" rx="14" fill="#22c55e"/></svg>`;
  return nativeImage.createFromDataURL('data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'));
}

function createTrayIcon() {
  try {
    const trayPng = resolveAsset('icon-32.png') || resolveAsset('icon-24.png') || resolveAsset('icon.png');
    if (trayPng) {
      const img = nativeImage.createFromPath(trayPng);
      if (!img.isEmpty()) return img.resize({ width: 24, height: 24 });
    }
  } catch {}
  return getAppIcon().resize({ width: 24, height: 24 });
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    applyGlobalHotkey();
    return;
  }
  try {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } catch {}
}

function updateTrayMenu() {
  if (!tray) return;
  const appName = 'Local Speech';
  const autoStartEnabled = isAutoStartEnabled();
  const contextMenu = Menu.buildFromTemplate([
    { label: `Show ${appName}`, click: () => showMainWindow() },
    {
      label: 'Start at login',
      type: 'checkbox',
      checked: autoStartEnabled,
      click: (item) => {
        const r = setAutoStartEnabled(!!item.checked);
        const cfg = loadConfig(); cfg.autoStart = isAutoStartEnabled(); saveConfig(cfg);
        if (!r.ok && r.error) console.error('[autostart]', r.error);
        updateTrayMenu();
        if (mainWindow && !mainWindow.isDestroyed()) { try { mainWindow.webContents.send('status-changed'); } catch {} }
      }
    },
    { type: 'separator' },
    { label: 'Exit', click: () => { isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(contextMenu);
}

function createTray() {
  if (tray) return tray;
  try {
    const icon = createTrayIcon();
    tray = new Tray(icon);
    tray.setToolTip('Local Speech');
    updateTrayMenu();
    tray.on('click', () => showMainWindow());
    tray.on('double-click', () => showMainWindow());
  } catch (e) {
    console.error('[tray] failed to create tray', e);
  }
  return tray;
}


function isMainWindowVisible() {
  try { return !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized()); } catch { return false; }
}

function positionWidgetWindow() {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  try {
    const display = screen.getPrimaryDisplay();
    const wa = (display && display.workArea) ? display.workArea : { x: 0, y: 0, width: 1280, height: 720 };
    const b = widgetWindow.getBounds();
    const x = Math.round(wa.x + wa.width - b.width - 20);
    const y = Math.round(wa.y + wa.height - b.height - 20);
    widgetWindow.setPosition(x, y, false);
  } catch {}
}

function createWidgetWindow() {
  if (widgetWindow && !widgetWindow.isDestroyed()) return widgetWindow;
  widgetWindow = new BrowserWindow({
    width: 220,
    height: 54,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    closable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'widget-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  try { widgetWindow.setAlwaysOnTop(true, 'screen-saver'); } catch {}
  try { widgetWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch {}
  widgetWindow.loadFile(path.join(__dirname, 'widget.html'));
  widgetWindow.on('closed', () => { widgetWindow = null; });
  positionWidgetWindow();
  return widgetWindow;
}

function updateWidgetVisibility() {
  try {
    if (!listeningActive) {
      if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.hide();
      return;
    }
    if (isMainWindowVisible()) {
      if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.hide();
      return;
    }
    const w = createWidgetWindow();
    if (!w || w.isDestroyed()) return;
    positionWidgetWindow();
    if (!w.isVisible()) w.showInactive();
  } catch {}
}

function sendWidgetState(payload) {
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    try { widgetWindow.webContents.send('widget-state', payload || {}); } catch {}
  }
}
function sendWidgetLevel(payload) {
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    try { widgetWindow.webContents.send('widget-level', payload || {}); } catch {}
  }
}


function createWindow() {
  const appIcon = getAppIcon();
  const win = new BrowserWindow({
    width: 1040, height: 700,
    minWidth: 1040, minHeight: 700,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    show: true,
    backgroundColor: '#070b18',
    icon: appIcon,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
    title: 'Local Speech',
  });
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      try { win.hide(); } catch {}
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    try { if (/^https?:/i.test(url)) shell.openExternal(url); } catch {}
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) { e.preventDefault(); try { if (/^https?:/i.test(url)) shell.openExternal(url); } catch {} }
  });
  win.on('minimize', () => updateWidgetVisibility());
  win.on('restore', () => updateWidgetVisibility());
  win.on('show', () => updateWidgetVisibility());
  win.on('hide', () => updateWidgetVisibility());
  win.on('focus', () => updateWidgetVisibility());
  win.on('blur', () => updateWidgetVisibility());
  win.loadFile(path.join(__dirname, 'index.html'));
  mainWindow = win;
  return win;
}

app.whenReady().then(() => {
  cleanupOldRecordings();
  ipcMain.handle('window-minimize', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.minimize(); return { ok: true }; });
  ipcMain.handle('window-close', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.close(); return { ok: true }; });
  ipcMain.handle('listening-state', (_e, payload) => {
    const p = payload || {};
    listeningActive = !!p.active;
    if (listeningActive) {
      sendWidgetState({ label: p.label || 'Listening', sub: p.sub || 'Microphone active', level: 0.05, speaking: false });
    }
    updateWidgetVisibility();
    return { ok: true };
  });
  ipcMain.handle('listening-level', (_e, payload) => {
    if (!listeningActive) return { ok: false };
    sendWidgetLevel(payload || {});
    return { ok: true };
  });
  ipcMain.handle('get-status', async () => await getStatus());
  ipcMain.handle('ensure-llama-server', async (e) => { const r = await ensureManagedLlamaServer((l) => { try { e.sender.send('transcribe-log', l); } catch {} }); managedLlama.lastEnsure = r; return { ...r, status: await getStatus() }; });
  ipcMain.handle('stop-llama-server', async () => { stopManagedLlamaServer(); return { ok: true, status: await getStatus() }; });
  ipcMain.handle('pick-audio', async (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    const res = await dialog.showOpenDialog(w, { title: 'Select audio file to transcribe', properties: ['openFile'], filters: [{ name: 'Audio', extensions: ['wav', 'mp3', 'm4a', 'ogg', 'flac', 'webm', 'opus'] }, { name: 'All files', extensions: ['*'] }] });
    if (res.canceled || !res.filePaths[0]) return { canceled: true };
    return { canceled: false, path: res.filePaths[0] };
  });
  ipcMain.handle('get-history', () => loadHistory());
  ipcMain.handle('clear-history', async () => { saveHistory([]); return await getStatus(); });
  ipcMain.handle('delete-history-item', async (_e, id) => { const items = loadHistory().filter(x => x.id !== id); saveHistory(items); return await getStatus(); });
  ipcMain.handle('copy-text', (_e, text) => { try { clipboard.writeText(String(text || '')); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } });
  ipcMain.handle('set-auto-copy', async (_e, v) => { const cfg = loadConfig(); cfg.autoCopy = !!v; saveConfig(cfg); return await getStatus(); });
  ipcMain.handle('set-auto-paste', async (_e, v) => { const cfg = loadConfig(); cfg.autoPaste = !!v; saveConfig(cfg); return await getStatus(); });
  ipcMain.handle('set-default-language', async (_e, v) => { const cfg = loadConfig(); const allowed = new Set(['auto','en','ro','de','fr','es','it','pt','nl','pl','uk','ru']); const lang = String(v || 'en'); cfg.defaultLanguage = allowed.has(lang) ? lang : 'en'; saveConfig(cfg); return await getStatus(); });
  ipcMain.handle('set-auto-stop-seconds', async (_e, v) => { const cfg = loadConfig(); const n = Number(v); cfg.autoStopSeconds = Number.isFinite(n) ? Math.min(60, Math.max(1, Math.round(n))) : 3; saveConfig(cfg); return await getStatus(); });
  ipcMain.handle('set-auto-start', async (_e, v) => {
    const r = setAutoStartEnabled(!!v);
    const cfg = loadConfig(); cfg.autoStart = isAutoStartEnabled(); saveConfig(cfg);
    updateTrayMenu();
    return { ...r, status: await getStatus() };
  });
  ipcMain.handle('set-global-hotkey', async (_e, payload) => {
    const { enabled, accelerator } = payload || {};
    const cfg = loadConfig();
    if (typeof enabled === 'boolean') cfg.globalHotkeyEnabled = enabled;
    if (typeof accelerator === 'string' && accelerator.trim()) cfg.globalHotkey = accelerator.trim();
    saveConfig(cfg);
    const hotkey = applyGlobalHotkey();
    return { status: await getStatus(), hotkey };
  });
  ipcMain.handle('set-llama-url', async (_e, url) => { const cfg = loadConfig(); cfg.llamaServerUrl = (url || '').trim(); saveConfig(cfg); return await getStatus(); });
  ipcMain.handle('transcribe', async (e, payload) => {
    const { audioPath, language } = payload || {};
    const result = await transcribeWithLlama(audioPath, language, e.sender);
    if (result && result.ok && (result.transcript || '').trim()) {
      addHistory({ source: 'file', audioPath, language: language || 'auto', transcript: result.transcript, ms: result.ms });
      result.auto = maybeAutoPaste(result.transcript);
    }
    return { ...result, status: await getStatus() };
  });
  ipcMain.handle('transcribe-mic', async (e, payload) => {
    const { buffer, mimeType, language } = payload || {};
    let saved = null;
    try {
      saved = saveMicRecording(buffer, mimeType);
      try { e.sender.send('transcribe-log', `[mic] audio captured for STT\n`); } catch {}
      if (saved.convErr) { try { e.sender.send('transcribe-log', `[mic] ffmpeg warning: ${saved.convErr}\n`); } catch {} }
      const result = await transcribeWithLlama(saved.finalPath, language, e.sender);
      if (result && result.ok && (result.transcript || '').trim()) {
        addHistory({ source: 'mic', audioPath: '(not stored)', language: language || 'auto', transcript: result.transcript, ms: result.ms });
        result.auto = maybeAutoPaste(result.transcript);
      }
      return { ...result, status: await getStatus() };
    } catch (err) {
      const msg = (err && err.code === 'ENOSPC') ? 'No space left on device while processing microphone audio.' : (err && err.message) || String(err);
      try { e.sender.send('transcribe-log', `[mic error] ${msg}\n`); } catch {}
      return { ok: false, error: msg, code: err && err.code, status: await getStatus() };
    } finally {
      if (saved) {
        for (const fp of [saved.finalPath, saved.rawPath, saved.wavPath]) {
          try { if (fp && fs.existsSync(fp)) fs.unlinkSync(fp); } catch {}
        }
      }
    }
  });
  ipcMain.handle('transcribe-live-chunk', async (e, payload) => {
    const { buffer, mimeType, language, seq } = payload || {};
    let rawPath = null, finalPath = null, wavPath = null;
    try {
      const dir = ensureDir(path.join(app.getPath('userData'), 'recordings', 'live'));
      const ts = Date.now();
      const ext = (mimeType && mimeType.includes('wav')) ? 'wav' : (mimeType && mimeType.includes('ogg')) ? 'ogg' : 'webm';
      rawPath = path.join(dir, `live-${ts}-${seq || 0}.${ext}`);
      fs.writeFileSync(rawPath, Buffer.from(buffer));
      wavPath = rawPath.replace(/\.[^.]+$/, '.wav');
      const ff = findCmd(['ffmpeg']);
      finalPath = rawPath;
      let converted = false, convErr = null;
      if (ff && ext !== 'wav') {
        const r = spawnSync(ff, ['-y', '-i', rawPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath], { encoding: 'utf8' });
        if (r.status === 0 && fs.existsSync(wavPath)) { finalPath = wavPath; converted = true; }
        else convErr = (r.stderr || r.stdout || 'ffmpeg conversion failed').slice(-400);
      } else if (ext === 'wav') { finalPath = rawPath; converted = true; }
      try { e.sender.send('transcribe-log', `[live#${seq || 0}] audio chunk ready for STT\n`); } catch {}
      if (convErr) { try { e.sender.send('transcribe-log', `[live#${seq || 0}] ffmpeg warning: ${convErr}\n`); } catch {} }
      const result = await transcribeWithLlama(finalPath, language, e.sender);
      return { ...result, seq };
    } catch (err) {
      const msg = (err && err.code === 'ENOSPC') ? 'No space left on device while processing live audio chunk. Free disk space.' : (err && err.message) || String(err);
      try { e.sender.send('transcribe-log', `[live#${seq || 0} error] ${msg}\n`); } catch {}
      return { ok: false, error: msg, code: err && err.code, seq };
    } finally {
      for (const fp of [finalPath, wavPath, rawPath]) {
        try { if (fp && fs.existsSync(fp)) fs.unlinkSync(fp); } catch {}
      }
    }
  });
  ipcMain.handle('save-live-history', async (_e, payload) => {
    const { transcript, language, ms, forcePaste } = payload || {};
    let auto = null;
    if ((transcript || '').trim()) { addHistory({ source: 'live', audioPath: '(chunked live session)', language: language || 'auto', transcript, ms: ms || null }); auto = maybeAutoPaste(transcript, { forcePaste: !!forcePaste }); }
    return { status: await getStatus(), auto };
  });

  createWindow();
  createTray();
  applyGlobalHotkey();
  ensureManagedLlamaServer().then(r => { managedLlama.lastEnsure = r; }).catch(() => {});
  app.on('activate', () => { showMainWindow(); applyGlobalHotkey(); });
});
app.on('before-quit', () => { isQuitting = true; stopManagedLlamaServer(); if (tray) { try { tray.destroy(); } catch {} tray = null; } });
app.on('will-quit', () => { stopManagedLlamaServer(); try { globalShortcut.unregisterAll(); } catch {} });
app.on('window-all-closed', () => { if (isQuitting) app.quit(); });
