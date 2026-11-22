function u(re, flags = 'giu') {
  return new RegExp(re, flags);
}
const W = '(?<![\\p{L}\\p{M}\\p{N}_])';
const WEND = '(?![\\p{L}\\p{M}\\p{N}_])';

const FILLER_PATTERNS = {
  en: [u(`${W}(?:um+|uh+|erm+|hmm+|mm+|ah+|uh-huh|like,\\s|you know,\\s)${WEND}[,. ]*`)],
  ro: [u(`${W}(?:ăă+|mmm+|hm+|ăh+|paa?i|gen|adică)${WEND}[,. ]*`)],
  es: [u(`${W}(?:eh+|em+|este|o sea|pues)${WEND}[,. ]*`)],
  fr: [u(`${W}(?:euh+|hum+|bah|ben|genre)${WEND}[,. ]*`)],
  de: [u(`${W}(?:äh+|ähm+|hm+|also|halt)${WEND}[,. ]*`)],
  it: [u(`${W}(?:eh+|mmm+|cioè|allora)${WEND}[,. ]*`)],
  pt: [u(`${W}(?:hã+|ahn+|éé+|tipo|né)${WEND}[,. ]*`)],
  '*': [u(`${W}(?:um+|uh+|erm+|hmm+|mm+|ah+)${WEND}[,. ]*`)],
};

const SELF_CORRECTION_PATTERNS = {
  en: [u(`${W}(?:no wait|actually no|sorry[, ]+i mean|i mean|i meant|rather)${WEND}[,: ]*`)],
  ro: [u(`${W}(?:nu stai|adică nu|vreau să spun|de fapt nu)${WEND}[,: ]*`)],
  es: [u(`${W}(?:no espera|quiero decir|mejor dicho|o mejor)${WEND}[,: ]*`)],
  fr: [u(`${W}(?:non attends|je veux dire|plutôt|en fait non)${WEND}[,: ]*`)],
  de: [u(`${W}(?:nein warte|ich meine|lieber gesagt|eigentlich nicht)${WEND}[,: ]*`)],
  it: [u(`${W}(?:no aspetta|voglio dire|anzi|in realtà no)${WEND}[,: ]*`)],
  pt: [u(`${W}(?:não espera|quer dizer|melhor dizendo|na verdade não)${WEND}[,: ]*`)],
  '*': [u(`${W}(?:no wait|actually no|sorry|i mean|i meant)${WEND}[,: ]*`)],
};

const PUNCTUATION_COMMANDS = [
  { re: u(`(^|\\s)${W}new paragraph${WEND}(?=\\s|$|[,.!?])`), out: '$1\n\n' },
  { re: u(`(^|\\s)${W}new line${WEND}(?=\\s|$|[,.!?])`), out: '$1\n' },
  { re: u(`(^|\\s)${W}question mark${WEND}(?=\\s|$|[,.!?])`), out: '$1?' },
  { re: u(`(^|\\s)${W}exclamation point${WEND}(?=\\s|$|[,.!?])`), out: '$1!' },
  { re: u(`(^|\\s)${W}exclamation mark${WEND}(?=\\s|$|[,.!?])`), out: '$1!' },
  { re: u(`(^|\\s)${W}comma${WEND}(?=\\s|$|[,.!?])`), out: '$1,' },
  { re: u(`(^|\\s)${W}period${WEND}(?=\\s|$|[,.!?])`), out: '$1.' },
  { re: u(`(^|\\s)${W}full stop${WEND}(?=\\s|$|[,.!?])`), out: '$1.' },
  { re: u(`(^|\\s)${W}colon${WEND}(?=\\s|$|[,.!?])`), out: '$1:' },
  { re: u(`(^|\\s)${W}semicolon${WEND}(?=\\s|$|[,.!?])`), out: '$1;' },
  { re: u(`(^|\\s)${W}dash${WEND}(?=\\s|$|[,.!?])`), out: '$1 - ' },
  { re: u(`(^|\\s)${W}open quote${WEND}(?=\\s|$|[,.!?])`), out: '$1"' },
  { re: u(`(^|\\s)${W}close quote${WEND}(?=\\s|$|[,.!?])`), out: '$1"' },
];

function normalizeLang(language) {
  const l = String(language || '').trim().toLowerCase();
  if (!l || l === 'auto') return '*';
  const short = l.split(/[-_]/)[0];
  return FILLER_PATTERNS[short] ? short : '*';
}

function patternsFor(language, table) {
  const lang = normalizeLang(language);
  const out = [...(table['*'] || [])];
  if (lang !== '*' && table[lang]) out.push(...table[lang]);
  return out;
}

function cleanupWhitespace(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([,.;:!?])(?=[A-Za-zÀ-ÿ0-9])/g, '$1 ')
    .replace(/\n\n\s+/g, '\n\n')
    .trim();
}

function capitalizeSentences(text) {
  return text.replace(/(^|[.!?\n]\s+)([a-zà-ÿ])/g, (m, p, c) => p + c.toUpperCase());
}

function applyProfile(text, profile) {
  const p = String(profile || 'default').toLowerCase();
  if (p === 'email') {
    // Keep paragraphs and sentence punctuation; ensure greeting/closing spacing is gentle.
    return text.replace(/\n{3,}/g, '\n\n').trim();
  }
  if (p === 'chat') {
    // Compact whitespace, preserve casual tone, avoid forcing excessive paragraph breaks.
    return text.replace(/\n{2,}/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
  }
  if (p === 'code') {
    // Minimal transformation: preserve most symbols/case, only normalize obvious spacing.
    return String(text || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/[ \t]+\n/g, '\n').trim();
  }
  return text;
}

function formatTranscript(text, opts = {}) {
  let out = String(text || '').trim();
  if (!out) return { text: out, applied: [], profile: opts.profile || 'default', language: opts.language || 'auto' };
  const applied = [];
  const profile = String(opts.profile || 'default').toLowerCase();
  const language = opts.language || 'auto';

  if (opts.punctuationCommands) {
    for (const cmd of PUNCTUATION_COMMANDS) out = out.replace(cmd.re, cmd.out);
    applied.push('punctuationCommands');
  }
  if (opts.removeFillers) {
    for (const re of patternsFor(language, FILLER_PATTERNS)) out = out.replace(re, ' ');
    applied.push('removeFillers');
  }
  if (opts.removeSelfCorrections) {
    for (const re of patternsFor(language, SELF_CORRECTION_PATTERNS)) out = out.replace(re, ' ');
    applied.push('selfCorrections');
  }

  out = cleanupWhitespace(out);
  const shouldCapitalize = opts.capitalize !== false && profile !== 'code';
  if (shouldCapitalize) {
    out = capitalizeSentences(out);
    if (out) out = out.charAt(0).toUpperCase() + out.slice(1);
    applied.push('capitalize');
  }
  out = applyProfile(out, profile);
  out = cleanupWhitespace(out);
  return { text: out, applied, profile, language };
}

module.exports = { formatTranscript, normalizeLang, applyProfile };