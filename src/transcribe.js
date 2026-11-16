const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

function buildMultipart(fields, fileField, filePath) {
  const boundary = '----localspeech' + Math.random().toString(16).slice(2);
  const chunks = [];
  const push = (s) => chunks.push(Buffer.from(s));
  for (const [k, v] of Object.entries(fields || {})) {
    if (v == null || v === '') continue;
    push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
  }
  const filename = path.basename(filePath);
  push(`--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  chunks.push(fs.readFileSync(filePath));
  push(`\r\n--${boundary}--\r\n`);
  return { body: Buffer.concat(chunks), boundary };
}

function requestMultipart(urlStr, fields, fileField, filePath, timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve) => {
    try {
      const u = new URL(urlStr);
      const { body, boundary } = buildMultipart(fields, fileField, filePath);
      const client = u.protocol === 'https:' ? https : http;
      const req = client.request({
        protocol: u.protocol, hostname: u.hostname, port: u.port, path: u.pathname + (u.search || ''),
        method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
        timeout: timeoutMs,
      }, (res) => {
        let data = ''; res.setEncoding('utf8');
        res.on('data', c => data += c);
        res.on('end', () => resolve({ status: res.statusCode, data }));
      });
      req.on('timeout', () => { try { req.destroy(); } catch {} resolve({ status: 0, error: 'timeout' }); });
      req.on('error', (e) => resolve({ status: 0, error: e.message }));
      req.write(body); req.end();
    } catch (e) { resolve({ status: 0, error: e.message }); }
  });
}

function postJson(urlStr, payload, timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve) => {
    try {
      const u = new URL(urlStr);
      const body = Buffer.from(JSON.stringify(payload));
      const client = u.protocol === 'https:' ? https : http;
      const req = client.request({ protocol: u.protocol, hostname: u.hostname, port: u.port, path: u.pathname + (u.search || ''), method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': body.length }, timeout: timeoutMs }, (res) => {
        let data = ''; res.setEncoding('utf8'); res.on('data', c => data += c);
        res.on('end', () => resolve({ status: res.statusCode, data }));
      });
      req.on('timeout', () => { try { req.destroy(); } catch {} resolve({ status: 0, error: 'timeout' }); });
      req.on('error', (e) => resolve({ status: 0, error: e.message }));
      req.write(body); req.end();
    } catch (e) { resolve({ status: 0, error: e.message }); }
  });
}

function sanitizeTranscript(text) {
  if (text == null) return '';
  let t = String(text);

  // Prefer extracting transcript payload from <asr_text>...</asr_text> (closed or unclosed)
  const openTag = /<asr_text\b[^>]*>/i;
  const openMatch = t.match(openTag);
  if (openMatch) {
    const start = openMatch.index + openMatch[0].length;
    const rest = t.slice(start);
    const closeIdx = rest.search(/<\/asr_text>/i);
    t = closeIdx >= 0 ? rest.slice(0, closeIdx) : rest;
  } else {
    t = t.replace(/<\/?asr_text\b[^>]*>/gi, '');
  }

  // Remove common leading metadata like "language English" / "language: en"
  t = t.replace(/^\s*language\s*[:\-]?\s*[^\r\n<]*/i, '');
  t = t.replace(/^\s*[\|:>\-–—]+\s*/, '');

  // Remove common special tokens/tags and normalize whitespace
  t = t.replace(/<\|[^>]+?\|>/g, '');
  t = t.replace(/<\/?[^>]+>/g, '');
  t = t.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return t;
}

function parseTextFromResponse(data) {
  if (!data) return { text: '', err: null };
  try {
    const j = JSON.parse(data);
    if (j && j.error) {
      let errMsg = j.error.message || JSON.stringify(j.error);
      if (/chat\/completions|not_supported/i.test(errMsg)) {
        errMsg = 'This model is not supported for server-based transcription by the current llama-server build. Try Qwen3-ASR.';
      }
      return { text: '', err: errMsg, json: j };
    }
    let text = '';
    if (typeof j === 'string') text = j;
    else if (j && typeof j.text === 'string') text = j.text;
    else if (j && typeof j.transcription === 'string') text = j.transcription;
    else if (j && typeof j.content === 'string') text = j.content;
    else if (j && Array.isArray(j.segments)) text = j.segments.map(s => s.text || '').join('');
    else if (j && j.choices && j.choices[0] && j.choices[0].message) {
      const c = j.choices[0].message.content;
      text = Array.isArray(c) ? c.map(x => (typeof x === 'string' ? x : (x.text || ''))).join('\n') : (c || '');
    } else if (j && j.choices && j.choices[0] && j.choices[0].text) text = String(j.choices[0].text);
    return { text: sanitizeTranscript(text), json: j };
  } catch {
    return { text: sanitizeTranscript(String(data)), json: null };
  }
}

function audioMimeFromPath(p) {
  const ext = path.extname(p).toLowerCase();
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.ogg' || ext === '.opus') return 'audio/ogg';
  if (ext === '.flac') return 'audio/flac';
  if (ext === '.m4a') return 'audio/mp4';
  if (ext === '.webm') return 'audio/webm';
  return 'audio/wav';
}

async function tryAudioTranscriptions(baseUrl, audioPath, language, onLine) {
  const endpoint = `${baseUrl.replace(/\/$/, '')}/v1/audio/transcriptions`;
  const fields = { response_format: 'json', model: 'asr' };
  if (language && language !== 'auto') fields.language = language;
  onLine && onLine(`$ POST ${endpoint} (multipart file=${path.basename(audioPath)})\n`);
  const started = Date.now();
  const r = await requestMultipart(endpoint, fields, 'file', audioPath);
  const ms = Date.now() - started;
  const p = parseTextFromResponse(r.data);
  if (r.status >= 200 && r.status < 300 && !p.err && p.text) {
    onLine && onLine(`[llama.cpp] /v1/audio/transcriptions ok in ${ms}ms\n`);
    return { ok: true, code: 0, ms, transcript: p.text, cmdline: `POST ${endpoint}`, stdout: r.data };
  }
  return { ok: false, code: r.status, ms, transcript: p.text || '', error: p.err || r.error || `HTTP ${r.status}`, cmdline: `POST ${endpoint}`, stdout: r.data };
}

async function tryInference(baseUrl, audioPath, language, onLine) {
  const endpoint = `${baseUrl.replace(/\/$/, '')}/inference`;
  const fields = { response_format: 'json', temperature: '0.0', temperature_inc: '0.2' };
  if (language && language !== 'auto') fields.language = language;
  onLine && onLine(`$ POST ${endpoint} (multipart file=${path.basename(audioPath)})\n`);
  const started = Date.now();
  const r = await requestMultipart(endpoint, fields, 'file', audioPath);
  const ms = Date.now() - started;
  const p = parseTextFromResponse(r.data);
  if (r.status >= 200 && r.status < 300 && !p.err && p.text) {
    onLine && onLine(`[llama.cpp] /inference ok in ${ms}ms\n`);
    return { ok: true, code: 0, ms, transcript: p.text, cmdline: `POST ${endpoint}`, stdout: r.data };
  }
  return { ok: false, code: r.status, ms, transcript: p.text || '', error: p.err || r.error || `HTTP ${r.status}`, cmdline: `POST ${endpoint}`, stdout: r.data };
}

async function tryChatCompletions(baseUrl, audioPath, language, onLine) {
  const endpoint = `${baseUrl.replace(/\/$/, '')}/v1/chat/completions`;
  onLine && onLine(`$ POST ${endpoint} (chat + input_audio)\n`);
  const started = Date.now();
  const b64 = fs.readFileSync(audioPath).toString('base64');
  const fmt = path.extname(audioPath).replace('.', '').toLowerCase() || 'wav';
  const prompt = language && language !== 'auto'
    ? `Transcribe this audio accurately. Language: ${language}. Return only the transcript text.`
    : 'Transcribe this audio accurately. Return only the transcript text.';
  const payloads = [
    { model: 'asr', temperature: 0, messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: b64, format: fmt } }, { type: 'text', text: prompt }] }] },
    { model: 'asr', temperature: 0, messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { url: `data:${audioMimeFromPath(audioPath)};base64,${b64}` } }, { type: 'text', text: prompt }] }] },
  ];
  let last = null;
  for (const payload of payloads) {
    const r = await postJson(endpoint, payload);
    const ms = Date.now() - started;
    const p = parseTextFromResponse(r.data);
    if (r.status >= 200 && r.status < 300 && !p.err && p.text) {
      onLine && onLine(`[llama.cpp] /v1/chat/completions ok in ${ms}ms\n`);
      return { ok: true, code: 0, ms, transcript: p.text, cmdline: `POST ${endpoint}`, stdout: r.data };
    }
    last = { ok: false, code: r.status, ms, transcript: p.text || '', error: p.err || r.error || `HTTP ${r.status}`, cmdline: `POST ${endpoint}`, stdout: r.data };
  }
  return last || { ok: false, error: 'chat transcription failed' };
}

async function runTranscription({ audioPath, language, baseUrl, onLine }) {
  if (!audioPath || !fs.existsSync(audioPath)) return { ok: false, error: `Audio file not found: ${audioPath || '(none)'}` };
  if (!baseUrl) return { ok: false, error: 'No llama-server URL available' };
  const attempts = [tryAudioTranscriptions, tryInference, tryChatCompletions];
  let last = null;
  for (const fn of attempts) {
    const r = await fn(baseUrl, audioPath, language, onLine);
    if (r && r.ok) return r;
    last = r;
    if (r && r.error) onLine && onLine(`[llama.cpp] attempt failed: ${r.error}\n`);
  }
  return last || { ok: false, error: 'Transcription failed on llama-server (no compatible endpoint succeeded)' };
}

module.exports = { runTranscription };
