const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { cleanupTranscript } = require('../src/cleanup.js');

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('cleanupTranscript returns cleaned text from chat completions', async () => {
  const server = await startServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const j = JSON.parse(body);
      assert.equal(j.enable_thinking, false);
      assert.equal(j.model, 'qwen3.6-colibri');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'Hello world.' } }] }));
    });
  });
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const r = await cleanupTranscript({ text: 'hello world', baseUrl, model: 'qwen3.6-colibri' });
    assert.equal(r.ok, true);
    assert.equal(r.text, 'Hello world.');
  } finally { server.close(); }
});

test('cleanupTranscript includes profile-specific prompt', async () => {
  let seenSystem = '';
  const server = await startServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const j = JSON.parse(body);
      seenSystem = j.messages[0].content;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
    });
  });
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    await cleanupTranscript({ text: 'hi', baseUrl, model: 'm', profile: 'email' });
    assert.match(seenSystem.toLowerCase(), /email/);
  } finally { server.close(); }
});

test('cleanupTranscript falls back on error', async () => {
  const server = await startServer((_req, res) => { res.writeHead(500); res.end('oops'); });
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const r = await cleanupTranscript({ text: 'original', baseUrl, model: 'm' });
    assert.equal(r.ok, false);
    assert.equal(r.text, 'original');
    assert.match(String(r.error), /HTTP 500/);
  } finally { server.close(); }
});
