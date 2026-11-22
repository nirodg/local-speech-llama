const test = require('node:test');
const assert = require('node:assert/strict');
const { formatTranscript } = require('../src/format.js');

test('removes fillers', () => {
  const r = formatTranscript('um hello uh world', { removeFillers: true });
  assert.equal(r.text, 'Hello world');
});

test('removes self corrections', () => {
  const r = formatTranscript('I want tea, no wait, coffee', { removeSelfCorrections: true, removeFillers: false });
  assert.equal(r.text, 'I want tea, coffee');
});

test('applies punctuation commands', () => {
  const r = formatTranscript('hello new paragraph how are you question mark', { punctuationCommands: true });
  assert.equal(r.text, 'Hello\n\nHow are you?');
});

test('cleans whitespace and capitalizes', () => {
  const r = formatTranscript('  hello   world. this is fine  ', { capitalize: true });
  assert.equal(r.text, 'Hello world. This is fine');
});

test('empty input', () => {
  const r = formatTranscript('   ', { removeFillers: true });
  assert.equal(r.text, '');
});

test('language-aware fillers (ro)', () => {
  const r = formatTranscript('ăă salut adică ce faci', { removeFillers: true, language: 'ro' });
  assert.match(r.text.toLowerCase(), /salut/);
  assert.doesNotMatch(r.text.toLowerCase(), /adică/);
});

test('code profile preserves case style minimally', () => {
  const r = formatTranscript('um const myVar = foo', { removeFillers: true, profile: 'code', capitalize: false });
  assert.match(r.text, /const myVar = foo/);
});

test('chat profile compacts newlines', () => {
  const r = formatTranscript('hello new paragraph world', { punctuationCommands: true, profile: 'chat' });
  assert.equal(r.text.includes('\n\n'), false);
});
