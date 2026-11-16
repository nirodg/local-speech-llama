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
  const defaults = { autoCopy: false, autoPaste: false, globalHotkeyEnabled: false, globalHotkey: 'CommandOrControl+Alt+Space', llamaServerUrl: '', defaultLanguage: 'en', autoStopSeconds: 3, autoStart: false, model: DEFAULT_MODEL_ID };
  try {
    const c = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    const merged = { ...defaults, ...c };
    // migrate legacy/unset model to default id
    if (!merged.model || (!findModelById(merged.model) && !findModelByHf(merged.model))) merged.model = DEFAULT_MODEL_ID;
    if (findModelByHf(merged.model)) merged.model = findModelByHf(merged.model).id;
    return merged;
  } catch {
    return { ...defaults };
  }
}
function saveConfig(cfg) { fs.mkdirSync(path.dirname(configPath()), { recursive: true }); fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2)); }

function loadHistory() { try { const h = JSON.parse(fs.readFileSync(historyPath(), 'utf8')); return Array.isArray(h) ? h : []; } catch { return []; } }
function saveHistory(items) { fs.mkdirSync(path.dirname(historyPath()), { recursive: true }); fs.writeFileSync(historyPath(), JSON.stringify(items.slice(0, 200), null, 2)); }
function addHistory(entry) { const items = loadHistory(); items.unshift({ id: 'h-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7), at: new Date().toISOString(), ...entry }); saveHistory(items); return items; }

// Pinned to the known-good local llama.cpp build (matches /home/dorin/.local/bin/llama).
const MANAGED_LLAMA_TAG = 'b12182';

const MODEL_CATALOG = [
  { id: 'qwen3-asr-1.7b-q8_0', repo: 'ggml-org/Qwen3-ASR-1.7B-GGUF', quant: 'Q8_0', hf: 'ggml-org/Qwen3-ASR-1.7B-GGUF:Q8_0', label: 'Qwen3-ASR 1.7B', quantLabel: 'Q8_0', tag: 'Default · Best accuracy', description: 'Best accuracy in this range (~5.76 WER), 30 languages, auto language detection.', size: '~2.4 GB', recommended: true },
  { id: 'qwen3-asr-0.6b-q8_0', repo: 'ggml-org/Qwen3-ASR-0.6B-GGUF', quant: 'Q8_0', hf: 'ggml-org/Qwen3-ASR-0.6B-GGUF:Q8_0', label: 'Qwen3-ASR 0.6B', quantLabel: 'Q8_0', tag: 'Fast · Lite', description: 'Smaller/faster, lower RAM; good for quick dictation.', size: '~1.5 GB' },
];
const DEFAULT_MODEL_ID = 'qwen3-asr-1.7b-q8_0';
function findModelById(id) { return MODEL_CATALOG.find(m => m.id === id) || null; }
function findModelByHf(hf) { return MODEL_CATALOG.find(m => m.hf === hf) || null; }
function getSelectedModelId(cfg) {
  const c = cfg || loadConfig();
  if (c.model && findModelById(c.model)) return c.model;
  if (c.model && findModelByHf(c.model)) return findModelByHf(c.model).id;
  return DEFAULT_MODEL_ID;
}
function getSelectedModel(cfg) { return findModelById(getSelectedModelId(cfg)) || findModelById(DEFAULT_MODEL_ID); }

let mainWindow = null;
let tray = null;
let isQuitting = false;
let widgetWindow = null;
let widgetVisible = false;
let listeningActive = false;
let registeredHotkey = null;
let hotkeyRegistration = { ok: false, registered: false, accelerator: null, error: null };
let managedLlama = { proc: null, port: 8178, startedByApp: false, bin: null, model: getSelectedModel().hf, url: null, log: '', lastEnsure: null };
let serverSetup = { state: 'idle', message: '', error: null, installing: false };
const SCAN_PORTS = [9931, 8080, 8178, 8081, 8082, 11434];

function setServerSetup(state, message, error = null) {
  serverSetup = { ...serverSetup, state, message: message || '', error: error || null, installing: state === 'installing-binary' };
  if (mainWindow && !mainWindow.isDestroyed()) { try { mainWindow.webContents.send('status-changed'); } catch {} }
}

// Serialize server install/start/restart operations so two flows don't race for the binary/port.
let ensureLock = Promise.resolve();
function runWithEnsureLock(fn) {
  const p = ensureLock.then(() => fn());
  ensureLock = p.catch(() => {});
  return p;
}

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

function getManagedLlamaBinPath() {
  try { return path.join(app.getPath('userData'), 'bin', 'llama-server'); } catch { return null; }
}

function findLlamaServerBin(opts = {}) {
  const preferManaged = !!opts.preferManaged;
  const managed = getManagedLlamaBinPath();
  const candidates = [];
  if (preferManaged && managed) candidates.push(managed);
  if (managed) candidates.push(managed);
  const fromPath = findCmd(['llama-server']);
  if (fromPath) candidates.push(fromPath);
  candidates.push('/usr/local/lib/ollama/llama-server');
  candidates.push('/usr/local/bin/llama-server');
  const seen = new Set();
  for (const c of candidates) {
    if (!c || seen.has(c)) continue; seen.add(c);
    try { if (fs.existsSync(c)) { fs.accessSync(c, fs.constants.X_OK); return c; } } catch {}
  }
  return null;
}

function getCachedModels() {
  const bin = findLlamaServerBin({ preferManaged: true });
  if (!bin) return [];
  try {
    const r = spawnSync(bin, ['--cache-list'], { encoding: 'utf8', timeout: 10000 });
    const out = (r.stdout || '') + '\n' + (r.stderr || '');
    const names = [];
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*\d+\.\s*(\S+)/);
      if (m) names.push(m[1].trim());
    }
    return names;
  } catch { return []; }
}

function isModelCached(hfSpec, cachedList) {
  const list = cachedList || getCachedModels();
  if (list && list.length) {
    if (list.includes(hfSpec)) return true;
    const repo = (hfSpec || '').split(':')[0];
    if (list.some(x => x === repo || x.startsWith(repo + ':'))) return true;
  }
  // also consider local HF cache files
  try { const r = resolveLocalModelFiles(findModelByHf(hfSpec) || { hf: hfSpec, repo: (hfSpec||'').split(':')[0], quant: (hfSpec||'').split(':')[1] || '' }); if (r && r.modelPath) return true; } catch {}
  return false;
}

function findFilesRecursive(dir, maxDepth = 4) {
  const out = [];
  function walk(d, depth) {
    if (depth > maxDepth) return;
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile()) out.push(p);
      else if (e.isSymbolicLink()) {
        // HF cache stores model files as symlinks inside snapshots/
        try { if (fs.statSync(p).isFile()) out.push(p); } catch {}
      }
    }
  }
  walk(dir, 0);
  return out;
}

function resolveLocalModelFiles(model) {
  if (!model) return null;
  const repo = model.repo || (model.hf || '').split(':')[0] || '';
  const quant = model.quant || ((model.hf || '').includes(':') ? (model.hf || '').split(':').pop() : '');
  if (!repo) return null;
  const repoKey = 'models--' + repo.replace(/\//g, '--');
  const home = app.getPath('home');
  const roots = [
    path.join(home, '.cache', 'huggingface', 'hub', repoKey),
    path.join(home, '.cache', 'llama.cpp', repoKey),
    path.join(home, '.cache', 'llama.cpp'),
  ];
  let files = [];
  for (const root of roots) {
    try { if (fs.existsSync(root)) files = files.concat(findFilesRecursive(root, 5)); } catch {}
  }
  if (!files.length) return null;
  const ggufs = files.filter(f => f.endsWith('.gguf'));
  const quantLower = String(quant || '').toLowerCase();
  const repoName = repo.split('/').pop() || '';
  const scoreModel = (f) => {
    const b = path.basename(f).toLowerCase();
    let s = 0;
    if (b.includes('mmproj')) return -1;
    if (quantLower && b.includes(quantLower.toLowerCase())) s += 10;
    if (repoName && b.includes(repoName.toLowerCase().replace(/[^a-z0-9]+/g, '-'))) s += 2;
    if (b.includes('q8_0')) s += 1;
    if (b.includes('q4')) s += 1;
    return s;
  };
  const scoreMmproj = (f) => {
    const b = path.basename(f).toLowerCase();
    if (!b.includes('mmproj')) return -1;
    let s = 0;
    if (quantLower && b.includes(quantLower.toLowerCase())) s += 10;
    if (b.includes('q8_0')) s += 3;
    if (b.includes('f16') || b.includes('bf16')) s += 2;
    return s;
  };
  const modelPath = ggufs.map(f => ({ f, s: scoreModel(f) })).filter(x => x.s >= 0).sort((a,b)=>b.s-a.s)[0]?.f || null;
  const mmprojPath = ggufs.map(f => ({ f, s: scoreMmproj(f) })).filter(x => x.s >= 0).sort((a,b)=>b.s-a.s)[0]?.f || null;
  if (!modelPath) return null;
  return { modelPath, mmprojPath };
}

function getModelsInfo() {
  const cached = getCachedModels();
  const selected = getSelectedModel();
  return {
    selectedId: selected.id,
    selectedHf: selected.hf,
    catalog: MODEL_CATALOG.map(m => {
      const local = resolveLocalModelFiles(m);
      return { ...m, cached: isModelCached(m.hf, cached), localAvailable: !!(local && local.modelPath) };
    }),
    cachedRaw: cached,
  };
}

function httpsJson(url, timeoutMs = 15000) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const req = https.get(url, { timeout: timeoutMs, headers: { 'User-Agent': 'local-speech', 'Accept': 'application/vnd.github+json' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { httpsJson(res.headers.location, timeoutMs).then(resolve); return; }
        let data = ''; res.setEncoding('utf8');
        res.on('data', c => data += c);
        res.on('end', () => { let j = null; try { j = JSON.parse(data); } catch {} resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: j, text: data }); });
      });
      req.on('timeout', () => { try { req.destroy(); } catch {} resolve({ ok: false }); });
      req.on('error', () => resolve({ ok: false }));
    } catch { resolve({ ok: false }); }
  });
}

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve) => {
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const file = fs.createWriteStream(dest);
      const req = https.get(url, { headers: { 'User-Agent': 'local-speech' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close(() => { try { fs.unlinkSync(dest); } catch {} downloadFile(res.headers.location, dest, onProgress).then(resolve); });
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) { file.close(() => { try { fs.unlinkSync(dest); } catch {} resolve({ ok: false, status: res.statusCode }); }); return; }
        const total = parseInt(res.headers['content-length'] || '0', 10) || 0;
        let got = 0;
        res.on('data', (chunk) => { got += chunk.length; if (onProgress) onProgress(got, total); });
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve({ ok: true, bytes: got })));
      });
      req.on('error', (e) => { try { file.close(() => fs.unlinkSync(dest)); } catch {} resolve({ ok: false, error: e.message }); });
      file.on('error', (e) => { try { file.close(() => fs.unlinkSync(dest)); } catch {} resolve({ ok: false, error: e.message }); });
    } catch (e) { resolve({ ok: false, error: e.message }); }
  });
}

async function installManagedLlamaServer(onLine) {
  const log = (s) => { try { onLine && onLine(s); } catch {} };
  if (process.platform !== 'linux' || process.arch !== 'x64') return { ok: false, error: 'Auto-install is currently supported on Linux x64 only. Please install llama-server manually.' };
  setServerSetup('installing-binary', `Downloading llama-server binary (${MANAGED_LLAMA_TAG})…`);
  log(`[llama-server] fetching llama.cpp ${MANAGED_LLAMA_TAG} Linux x64 binary...\n`);
  const rel = await httpsJson(`https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/${MANAGED_LLAMA_TAG}`);
  if (!rel.ok || !rel.json) { const e = `Failed to fetch llama.cpp release ${MANAGED_LLAMA_TAG} from GitHub.`; setServerSetup('error', e, e); return { ok: false, error: e }; }
  const asset = (rel.json.assets || []).find(x => /llama-.*bin-ubuntu-x64\.tar\.gz$/i.test(x.name));
  const tag = rel.json.tag_name || MANAGED_LLAMA_TAG;
  if (!asset) { const e = `Could not find a Linux x64 binary asset in ${tag}.`; setServerSetup('error', e, e); return { ok: false, error: e }; }
  const binDir = path.join(app.getPath('userData'), 'bin');
  const tmpDir = path.join(app.getPath('userData'), 'tmp', 'llama-install');
  const tarPath = path.join(tmpDir, asset.name);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(tmpDir, { recursive: true }); fs.mkdirSync(binDir, { recursive: true });
  log(`[llama-server] downloading ${asset.name} (${tag})...\n`);
  let lastPct = -1;
  const dl = await downloadFile(asset.browser_download_url, tarPath, (got, total) => {
    if (total) { const pct = Math.floor(got * 100 / total); if (pct !== lastPct && pct % 10 === 0) { lastPct = pct; log(`[llama-server] download ${pct}%\n`); setServerSetup('installing-binary', `Downloading llama-server binary… ${pct}%`); } }
  });
  if (!dl.ok) { const e = `Download failed${dl.status ? ' (HTTP '+dl.status+')' : ''}${dl.error ? ': '+dl.error : ''}`; setServerSetup('error', e, e); return { ok: false, error: e }; }
  setServerSetup('installing-binary', 'Extracting llama-server…');
  log('[llama-server] extracting...\n');
  const tarBin = findCmd(['tar']) || 'tar';
  const ex = spawnSync(tarBin, ['-xzf', tarPath, '-C', tmpDir], { encoding: 'utf8' });
  if (ex.status !== 0) { const e = `Extraction failed: ${(ex.stderr || ex.stdout || '').slice(-300)}`; setServerSetup('error', e, e); return { ok: false, error: e }; }
  // find llama-server and copy its directory contents (keeps shared libs together)
  let found = null;
  const stack = [tmpDir];
  while (stack.length && !found) {
    const d = stack.pop();
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isFile() && e.name === 'llama-server') { found = p; break; }
      if (e.isDirectory()) stack.push(p);
    }
  }
  if (!found) { const e = 'Downloaded archive did not contain a llama-server binary.'; setServerSetup('error', e, e); return { ok: false, error: e }; }
  const srcDir = path.dirname(found);
  let ents = []; try { ents = fs.readdirSync(srcDir, { withFileTypes: true }); } catch {}
  for (const e of ents) {
    const src = path.join(srcDir, e.name);
    const dst = path.join(binDir, e.name);
    try {
      if (e.isSymbolicLink()) {
        try { fs.unlinkSync(dst); } catch {}
        const linkTarget = fs.readlinkSync(src);
        fs.symlinkSync(linkTarget, dst);
      } else if (e.isFile()) {
        fs.copyFileSync(src, dst);
        if (/llama|\.so/.test(e.name) || e.name === 'llama-server') fs.chmodSync(dst, 0o755);
      }
    } catch {}
  }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  const managed = getManagedLlamaBinPath();
  if (!managed || !fs.existsSync(managed)) { const e = 'llama-server binary was not installed correctly.'; setServerSetup('error', e, e); return { ok: false, error: e }; }
  try { fs.chmodSync(managed, 0o755); } catch {}
  log(`[llama-server] installed managed binary: ${managed} (${tag})\n`);
  setServerSetup('starting', 'llama-server installed, starting…');
  return { ok: true, path: managed, tag, asset: asset.name };
}

async function ensureManagedLlamaServer(onLine, opts = {}) {
  const bin = findLlamaServerBin({ preferManaged: true });
  managedLlama.bin = bin;
  managedLlama.model = getSelectedModel().hf;
  if (!opts.forceManaged) {
    // if already running anywhere, use it
    const running = await detectRunningLlamaServer();
    if (running.running) {
      managedLlama.url = running.baseUrl;
      if (!(managedLlama.proc && !managedLlama.proc.killed && managedLlama.startedByApp)) managedLlama.startedByApp = false;
      setServerSetup('ready', `Using running llama-server at ${running.baseUrl}`);
      return { ok: true, running: true, reused: true, baseUrl: running.baseUrl, bin, model: managedLlama.model, health: running.health || null };
    }
  }
  if (managedLlama.proc && !managedLlama.proc.killed) {
    // already starting/running managed - wait for readiness below
  } else {
    if (!bin) {
      const err = 'llama-server binary not found. Install llama.cpp/llama-server, or use “Install llama-server” in the app to download a managed binary.';
      setServerSetup('error', err, err);
      return { ok: false, running: false, error: err, bin: null };
    }
    const port = managedLlama.port;
    const selected = getSelectedModel();
    const local = resolveLocalModelFiles(selected);
    let args;
    if (local && local.modelPath) {
      args = ['-m', local.modelPath];
      if (local.mmprojPath) args.push('--mmproj', local.mmprojPath);
      args.push('--host', '127.0.0.1', '--port', String(port), '-v');
      onLine && onLine(`[llama-server] using local model files:\n  model: ${local.modelPath}\n  mmproj: ${local.mmprojPath || '(none found)'}\n`);
      setServerSetup('starting', 'Starting llama-server with cached model…');
    } else {
      args = ['-hf', managedLlama.model, '--host', '127.0.0.1', '--port', String(port), '-v'];
      setServerSetup('starting', 'Starting llama-server (may download model if not cached)…');
    }
    onLine && onLine(`[llama-server] starting: ${bin} ${args.join(' ')}\n`);
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    managedLlama.proc = child; managedLlama.startedByApp = true; managedLlama.log = ''; managedLlama.url = `http://127.0.0.1:${port}`;
    child.stdout.on('data', d => { const t = d.toString(); managedLlama.log = (managedLlama.log + t).slice(-8000); onLine && onLine(t); });
    child.stderr.on('data', d => { const t = d.toString(); managedLlama.log = (managedLlama.log + t).slice(-8000); onLine && onLine(t); });
    child.on('exit', (code) => { if (managedLlama.proc === child) { managedLlama.proc = null; managedLlama.startedByApp = false; } managedLlama.lastExit = code; onLine && onLine(`[llama-server] exited (code ${code})\n`); });
  }
  const baseUrl = `http://127.0.0.1:${managedLlama.port}`;
  const start = Date.now();
  const timeoutMs = 15 * 60 * 1000; // allow first-run model download
  while (Date.now() - start < timeoutMs) {
    const r = await probeLlamaServer(baseUrl);
    if (r.running) { managedLlama.url = baseUrl; setServerSetup('ready', `llama-server running at ${baseUrl}`); return { ok: true, running: true, startedByApp: managedLlama.startedByApp, baseUrl, bin, model: managedLlama.model, pid: managedLlama.proc ? managedLlama.proc.pid : null }; }
    if (managedLlama.proc && managedLlama.proc.exitCode != null) break;
    await new Promise(res => setTimeout(res, 1000));
  }
  const r = await probeLlamaServer(baseUrl);
  const logTail = managedLlama.log.slice(-2000);
  let error = r.running ? null : 'llama-server not ready yet (it may still be downloading/loading the model)';
  if (!r.running && /HTTPS is not supported|failed to resolve commit|SSL|TLS|libcurl/i.test(logTail)) {
    error = 'Your llama-server cannot download models over HTTPS (built without HTTPS/SSL support). Use “Install llama-server” to get a managed binary with HTTPS support, or update llama-server / manually place the model GGUF + mmproj in the Hugging Face cache.';
  } else if (!r.running && /unknown model architecture|unsupported model|failed to load model|key not found|unknown argument/i.test(logTail)) {
    error = 'Selected model may not be supported by your installed llama-server (architecture/loader mismatch) or the launch failed. Update llama.cpp / llama-server to a newer build, or choose another model.';
  } else if (!r.running && managedLlama.proc && managedLlama.proc.exitCode != null) {
    error = `llama-server exited (code ${managedLlama.proc.exitCode}) before becoming ready. Check the server log for details.`;
  }
  if (!r.running) setServerSetup('error', error || 'Failed to start llama-server', error || null);
  return { ok: r.running, running: r.running, startedByApp: managedLlama.startedByApp, baseUrl, bin, model: managedLlama.model, pid: managedLlama.proc ? managedLlama.proc.pid : null, error, logTail: managedLlama.log.slice(-1200) };
}

async function autoEnsureServer(onLine, opts = {}) {
  const log = (s) => { try { onLine && onLine(s); } catch {} };
  if (!opts.forceManaged) {
    // 1) reuse if already running
    const running = await detectRunningLlamaServer();
    if (running.running) {
      managedLlama.url = running.baseUrl;
      managedLlama.startedByApp = false;
      setServerSetup('ready', `Using running llama-server at ${running.baseUrl}`);
      log(`[setup] reusing running llama-server at ${running.baseUrl}\n`);
      return { ok: true, running: true, reused: true, baseUrl: running.baseUrl };
    }
  }
  // 2) ensure binary exists (auto-install managed if none found)
  let bin = findLlamaServerBin({ preferManaged: true });
  if (!bin) {
    setServerSetup('installing-binary', 'No llama-server found. Downloading a managed binary…');
    log('[setup] no llama-server binary found, installing managed binary...\n');
    const inst = await installManagedLlamaServer(onLine);
    if (!inst.ok) { setServerSetup('error', inst.error || 'Failed to install llama-server', inst.error || null); return { ok: false, error: inst.error, installed: false }; }
    bin = inst.path || findLlamaServerBin({ preferManaged: true });
    if (!bin) { const e = 'Managed llama-server was installed but the binary path could not be resolved.'; setServerSetup('error', e, e); return { ok: false, error: e }; }
  }
  log(`[setup] using llama-server binary: ${bin}\n`);
  // 3) start server (downloads model if not cached/local)
  setServerSetup('starting', 'Starting llama-server (first run may download the model)…');
  let r = await ensureManagedLlamaServer(onLine, { forceManaged: !!opts.forceManaged });
  if (r.ok) { log(`[setup] llama-server ready at ${r.baseUrl}\n`); return r; }
  // 4) if failed due to HTTPS download limitation with a non-managed binary, auto-install managed binary and retry once
  const needsHttps = /cannot download models over HTTPS|HTTPS is not supported|failed to resolve commit/i.test((r.error || '') + '\n' + (managedLlama.log || ''));
  const usingManaged = !!(bin && getManagedLlamaBinPath() && path.resolve(bin) === path.resolve(getManagedLlamaBinPath()));
  const local = resolveLocalModelFiles(getSelectedModel());
  if (needsHttps && !usingManaged && !(local && local.modelPath)) {
    log('[setup] current llama-server cannot download over HTTPS; installing managed binary and retrying...\n');
    stopManagedLlamaServer();
    await new Promise(res => setTimeout(res, 400));
    const inst = await installManagedLlamaServer(onLine);
    if (inst.ok) {
      r = await ensureManagedLlamaServer(onLine, { forceManaged: true });
    } else {
      setServerSetup('error', inst.error || r.error || 'Failed to install managed llama-server', inst.error || r.error);
      return { ok: false, error: inst.error || r.error, install: inst };
    }
  }
  if (!r.ok && r.error) setServerSetup('error', r.error, r.error);
  return r;
}

function stopManagedLlamaServer() {
  const p = managedLlama.proc;
  managedLlama.proc = null;
  managedLlama.startedByApp = false;
  managedLlama.url = null;
  if (!p) return;
  const stillRunning = () => p.exitCode == null && p.signalCode == null;
  if (!stillRunning()) return;
  try { p.kill('SIGTERM'); } catch {}
  setTimeout(() => { if (stillRunning()) { try { p.kill('SIGKILL'); } catch {} } }, 2000);
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
  const selected = getSelectedModel(cfg);
  const externalInUse = !!(running.running && !(managedLlama.proc && !managedLlama.proc.killed && managedLlama.startedByApp && managedLlama.url === running.baseUrl));
  const managedBinPath = getManagedLlamaBinPath();
  const managedBinInstalled = !!(managedBinPath && fs.existsSync(managedBinPath));
  return {
    offline: false,
    ffmpeg,
    llamaServerBin,
    managedLlamaBin: { path: managedBinPath, installed: managedBinInstalled },
    server: {
      running: !!running.running || !!(managedLlama.proc && !managedLlama.proc.killed),
      baseUrl: baseUrl || null,
      managed: managedLlama.startedByApp && !!managedLlama.proc,
      external: externalInUse,
      pid: managedLlama.proc ? managedLlama.proc.pid : null,
      model: managedLlama.model,
      selectedModel: selected,
      models,
      logTail: managedLlama.log ? managedLlama.log.slice(-600) : '',
    },
    serverSetup,
    config: { ...cfg, autoStart: isAutoStartEnabled(), model: selected.id },
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
    onLine('[llama-server] no running instance detected, ensuring llama-server (may install/start)...\n');
    const ensured = await runWithEnsureLock(() => autoEnsureServer(onLine));
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
      label: 'Dictation widget',
      type: 'checkbox',
      checked: !!(widgetVisible && widgetWindow && !widgetWindow.isDestroyed() && widgetWindow.isVisible()),
      click: (item) => { if (item.checked) showWidget(); else hideWidget(); updateTrayMenu(); }
    },
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

function displayWidget() {
  try {
    const w = createWidgetWindow();
    if (!w || w.isDestroyed()) return;
    if (!w.isVisible()) w.showInactive();
  } catch {}
}
function showWidget() {
  widgetVisible = true;
  displayWidget();
}
function hideWidget() {
  widgetVisible = false;
  try {
    if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.hide();
  } catch {}
}
function toggleWidget() {
  if (widgetVisible && widgetWindow && !widgetWindow.isDestroyed() && widgetWindow.isVisible()) hideWidget();
  else showWidget();
}
function updateWidgetVisibility() {
  try {
    if (!listeningActive && !widgetVisible) {
      if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.hide();
      return;
    }
    if (isMainWindowVisible() && !widgetVisible) {
      if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.hide();
      return;
    }
    displayWidget();
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
  ipcMain.handle('show-widget', () => { showWidget(); updateTrayMenu(); return { ok: true }; });
  ipcMain.handle('hide-widget', () => { hideWidget(); updateTrayMenu(); return { ok: true }; });
  ipcMain.on('widget-clicked', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.webContents.send('widget-toggle-dictate'); } catch {}
    }
  });
  ipcMain.on('widget-close', () => {
    hideWidget();
    updateTrayMenu();
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.webContents.send('widget-stop-dictate'); } catch {}
    }
  });
  let widgetDragStartPos = null;
  ipcMain.on('widget-drag-start', () => {
    if (widgetWindow && !widgetWindow.isDestroyed()) {
      const b = widgetWindow.getBounds();
      widgetDragStartPos = { x: b.x, y: b.y };
    }
  });
  ipcMain.on('widget-drag-move', (_e, dx, dy) => {
    if (!widgetDragStartPos || !widgetWindow || widgetWindow.isDestroyed()) return;
    widgetWindow.setPosition(Math.round(widgetDragStartPos.x + dx), Math.round(widgetDragStartPos.y + dy), false);
  });
  ipcMain.on('widget-drag-end', () => { widgetDragStartPos = null; });
  ipcMain.handle('get-status', async () => await getStatus());
  ipcMain.handle('ensure-llama-server', async (e) => runWithEnsureLock(async () => {
    const r = await autoEnsureServer((l) => { try { e.sender.send('transcribe-log', l); } catch {} });
    managedLlama.lastEnsure = r;
    return { ...r, status: await getStatus(), models: getModelsInfo() };
  }));
  ipcMain.handle('stop-llama-server', async () => { stopManagedLlamaServer(); setServerSetup('idle', 'Managed server stopped'); return { ok: true, status: await getStatus() }; });
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
  ipcMain.handle('get-models', async () => getModelsInfo());
  ipcMain.handle('install-llama-server', async (e) => runWithEnsureLock(async () => {
    if (listeningActive) return { ok: false, error: 'Cannot install llama-server while listening/recording is active.', status: await getStatus() };
    stopManagedLlamaServer();
    await new Promise(res => setTimeout(res, 300));
    const r = await installManagedLlamaServer((l) => { try { e.sender.send('transcribe-log', l); } catch {} });
    // after manual install, try to start automatically
    let ensure = r;
    if (r && r.ok) ensure = await autoEnsureServer((l) => { try { e.sender.send('transcribe-log', l); } catch {} });
    return { ...r, ensure, status: await getStatus(), models: getModelsInfo() };
  }));
  ipcMain.handle('set-model', async (e, modelId) => runWithEnsureLock(async () => {
    if (listeningActive) return { ok: false, error: 'Cannot switch models while listening/recording is active. Stop first.', status: await getStatus(), models: getModelsInfo() };
    const m = findModelById(modelId);
    if (!m) return { ok: false, error: 'Unknown model selection.', status: await getStatus(), models: getModelsInfo() };
    const cfg = loadConfig();
    cfg.model = m.id;
    // applying a managed model should use the managed server
    cfg.llamaServerUrl = '';
    saveConfig(cfg);
    managedLlama.model = m.hf;
    // restart managed server to apply new model (installs binary if missing)
    stopManagedLlamaServer();
    // small delay to free port
    await new Promise(res => setTimeout(res, 400));
    const r = await autoEnsureServer((l) => { try { e.sender.send('transcribe-log', l); } catch {} }, { forceManaged: true });
    managedLlama.lastEnsure = r;
    return { ...r, status: await getStatus(), models: getModelsInfo() };
  }));
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
  runWithEnsureLock(() => autoEnsureServer()).then(r => { if (r) managedLlama.lastEnsure = r; }).catch(() => {});
  app.on('activate', () => { showMainWindow(); applyGlobalHotkey(); });
});
app.on('before-quit', () => { isQuitting = true; stopManagedLlamaServer(); if (tray) { try { tray.destroy(); } catch {} tray = null; } });
app.on('will-quit', () => { stopManagedLlamaServer(); try { globalShortcut.unregisterAll(); } catch {} });
app.on('window-all-closed', () => { if (isQuitting) app.quit(); });
