const http = require('http');
const https = require('https');

function postJson(urlStr, payload, timeoutMs = 30000) {
  return new Promise((resolve) => {
    try {
      const u = new URL(urlStr);
      const body = Buffer.from(JSON.stringify(payload));
      const client = u.protocol === 'https:' ? https : http;
      const req = client.request({
        protocol: u.protocol, hostname: u.hostname, port: u.port,
        path: u.pathname + (u.search || ''),
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
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

function extractContent(data) {
  try {
    const j = JSON.parse(data);
    if (j && j.error) return { text: '', error: j.error.message || JSON.stringify(j.error) };
    const msg = j && j.choices && j.choices[0] && j.choices[0].message;
    const content = msg && typeof msg.content === 'string' ? msg.content.trim() : '';
    return { text: content, error: content ? null : 'empty cleanup response' };
  } catch {
    return { text: '', error: 'invalid cleanup response' };
  }
}

const PROFILE_PROMPTS = {
  default: 'You clean up speech-to-text dictation. Fix punctuation, capitalization, and obvious transcription formatting. Remove filler words and false starts when clear. Preserve the speaker\'s meaning, tone, language, and wording as much as possible. Do not answer, summarize, translate, or add content. Return only the cleaned transcript.',
  email: 'You clean up speech-to-text dictation into clear email-ready text. Fix punctuation, capitalization, and formatting. Remove filler words and false starts when clear. Preserve meaning and intent; keep it professional but do not add greetings, signatures, or new content. Return only the cleaned transcript.',
  chat: 'You clean up speech-to-text dictation into concise chat-ready text. Fix punctuation and capitalization lightly, remove filler words and false starts when clear. Preserve tone and meaning; keep it natural and brief. Do not add content. Return only the cleaned transcript.',
  code: 'You clean up speech-to-text dictation that may contain technical terms, identifiers, or code. Preserve identifiers, casing, symbols, and technical wording as much as possible. Only remove obvious filler words/false starts and fix clear punctuation around prose. Do not rewrite code, do not add explanations. Return only the cleaned transcript.',
};

async function cleanupTranscript({ text, baseUrl, model, profile, onLine }) {
  const input = String(text || '').trim();
  if (!input) return { ok: true, text: input, skipped: true };
  if (!baseUrl) return { ok: false, text: input, error: 'No cleanup URL configured' };

  const endpoint = `${baseUrl.replace(/\/$/, '')}/v1/chat/completions`;
  const style = PROFILE_PROMPTS[String(profile || 'default').toLowerCase()] || PROFILE_PROMPTS.default;
  const payload = {
    model: model || 'qwen3.6-colibri',
    temperature: 0,
    max_tokens: Math.max(128, Math.min(4096, input.length * 4)),
    enable_thinking: false,
    messages: [
      {
        role: 'system',
        content: style,
      },
      { role: 'user', content: input },
    ],
  };

  onLine && onLine(`[cleanup] POST ${endpoint} model=${payload.model}\n`);
  const started = Date.now();
  const r = await postJson(endpoint, payload, 60000);
  const ms = Date.now() - started;
  if (r.status < 200 || r.status >= 300) {
    const err = r.error || `HTTP ${r.status}`;
    onLine && onLine(`[cleanup] failed in ${ms}ms: ${err}\n`);
    return { ok: false, text: input, error: err, ms };
  }
  const p = extractContent(r.data);
  if (p.error || !p.text) {
    onLine && onLine(`[cleanup] failed in ${ms}ms: ${p.error || 'empty'}\n`);
    return { ok: false, text: input, error: p.error || 'empty cleanup response', ms };
  }
  onLine && onLine(`[cleanup] ok in ${ms}ms\n`);
  return { ok: true, text: p.text, ms };
}

module.exports = { cleanupTranscript };
