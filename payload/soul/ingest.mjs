/**
 * soul/ingest.mjs — builds the Soul SQLite database from the FULL raw export
 * plus the existing _distill artifacts.
 *
 * Sources (all local, zero network):
 *   D:\projects\gpt output\conversations-*.json   full ChatGPT export (authoritative)
 *   D:\projects\gpt output\_distill\...            distillation metadata, atoms, safety gate
 *
 * Output:
 *   C:\Users\user\.config\opencode\soul\soul.db
 *
 * Run:  node ingest.mjs [--rebuild]
 * Docs: design notes in soul/DESIGN.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
// Gate + FTS-query normalization live in lib.mjs so ingest.mjs and server.mjs
// can never grade a claim differently. lib is pure and import-safe.
import { gateClaim } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(HERE, 'soul.db');
const RAW_DIR = 'D:/projects/gpt output';
const DISTILL = path.join(RAW_DIR, '_distill');
const TZ_OFFSET_MIN = 210; // +03:30

const log = (...a) => console.log('[ingest]', ...a);

// ────────────────────────────────────────────────────────────── text utils ──
const FA_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
const ZWNJ = /\u200C/g;

/** Persian-safe normalization: drop ZWNJ + tatweel, unify Arabic yeh/kaf, strip Arabic punctuation noise. */
function faNormalize(s) {
  return s
    .replace(ZWNJ, '')
    .replace(/\u0640/g, '')       // tatweel / kashida
    .replace(/\u0649/g, '\u06CC') // ARABIC YEH -> FARSI YEH
    .replace(/\u064A/g, '\u06CC') // ALEF MAKSURA -> FARSI YEH
    .replace(/\u06AA/g, '\u0647') // HEH GOAL -> HEH (avoids tokenizer splits)
    .replace(/\u0629/g, '\u0647') // TEH MARBUTA -> HEH
    .toLowerCase();
}

const words = (s) => s.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [];
function tokenSetForFa(s) {
  return (s.match(/[\p{L}\p{N}_]+/gu) || []).map((w) => faNormalize(w));
}

const isFa = (s) => FA_RE.test(s);
const hasEmoji = (s) => /\p{Extended_Pictographic}/u.test(s);

/**
 * Extract speakable text from a ChatGPT message content node.
 * Accepts:
 *   ctype "text"            → string parts
 *   ctype "multimodal_text" → voice-mode chats carry the words in
 *                             {content_type:"audio_transcription", text:"..."}
 *                             objects, and images/audio as *_asset_pointer objects.
 * Rejects ctype "thoughts" / "reasoning_recap" (model internals, not user voice)
 * and asset pointers (no recoverable text).
 */
const TEXT_CTYPE = new Set(['text', 'multimodal_text']);
function extractText(content) {
  if (!content || !TEXT_CTYPE.has(content.content_type)) return '';
  const out = [];
  const walk = (p) => {
    if (typeof p === 'string') { if (p.trim()) out.push(p.trim()); return; }
    if (Array.isArray(p)) { for (const x of p) walk(x); return; }
    if (!p || typeof p !== 'object') return;
    const t = p.content_type;
    if ((t === 'audio_transcription' || t === 'text') && typeof p.text === 'string' && p.text.trim()) { out.push(p.text.trim()); return; }
    // asset pointers hold no text, but some carry nested transcription frames
    if (Array.isArray(p.frames_asset_pointers)) for (const x of p.frames_asset_pointers) walk(x);
  };
  for (const p of (content.parts || [])) walk(p);
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

function readJson(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

// ──────────────────────────────────────────────────────── Persian translit ──
const FA_MAP = {
  'ا': 'a', 'أ': 'a', 'إ': 'e', 'آ': 'a', 'ب': 'b', 'پ': 'p', 'ت': 't', 'ث': 's', 'ج': 'j', 'چ': 'ch',
  'ح': 'h', 'خ': 'kh', 'د': 'd', 'ذ': 'z', 'ر': 'r', 'ژ': 'zh', 'س': 's', 'ش': 'sh', 'ص': 's', 'ض': 'z',
  'ط': 't', 'ظ': 'z', 'ع': "'", 'غ': 'gh', 'ف': 'f', 'ق': 'gh', 'ک': 'k', 'ك': 'k', 'گ': 'g',
  'ل': 'l', 'م': 'm', 'ن': 'n', 'و': 'o', 'ه': 'h', 'ی': 'i', 'ي': 'i', 'ة': 'h', 'ء': '',
};
/** Very rough Persian→Latin transliteration, for L2 search parity. */
function faTranslit(s) {
  return s.replace(/[\u0600-\u06FF\u0750-\u077F]/g, (ch) => {
    if (FA_MAP[ch] !== undefined) return FA_MAP[ch] + ' ';
    if (/[\u064A\u0649\u06CC]/.test(ch)) return 'i ';
    return '';
  }).replace(/\s+/g, ' ').trim();
}

// ───────────────────────────────────────────────────────────── persona mine ──
const DIRECT = [
  ['bare_imperative', /\b(do it|just do|go ahead|ship it|build it|make it|run it|do that|implement)\b/gi, 'issues imperatives with no preamble'],
  ['delegate', /\b(you decide|your call|whatever you say|as you want|do whatever)\b/gi, 'delegates the decision outright'],
  ['yes_ok', /^\s*(ok|okay|k|yes|yeah|yep|nah|no|done|good|nice|cool|exactly|correct|true)\b/gi, 'opens with a bare affirmation'],
  ['correction', /\b(no[,.]|not exactly|that.s wrong|incorrect|i said|actually|again|still not)\b/gi, 'corrects flatly and briefly'],
  ['refusal_neg', /\b(don.t|do not|never|no need|stop|quit|skip)\b/gi, 'negates directly'],
  ['status_request', /\b(where are we|what.s the status|progress|status\?)\b/gi, 'asks for position not diary'],
];
const TONE = [
  ['profanity', /\b(fuck|shit|damn|wtf|bullshit|bastard|asshole)\b/gi, 'swears plainly'],
  ['emphasis_allcaps', /\b[A-Z]{4,}\b/g, 'shouts key tokens in caps'],
  ['hedge_softener', /\b(maybe|perhaps|i guess|i think|probably|not sure|might)\b/gi, 'hedges before asking'],
  ['polite_please', /\b(please|pls|kindly|sorry|excuse me|thank you)\b/gi, 'rarely uses politeness'],
  ['emoji_use', /\p{Extended_Pictographic}/gu, 'uses emoji as punctuation'],
  ['persian', FA_RE, 'switches to Persian'],
  ['english', /[A-Za-z]{3,}/g, 'uses English'],
  ['code_block', /```/g, 'writes code blocks'],
  ['question_mark', /\?/g, 'asks questions'],
  ['exclaim', /!/g, 'exclamations'],
];
const IDENTITY = [
  ['first_person', /\b(i|me|my|mine|myself|i.m)\b/gi, 'first person'],
  ['second_person', /\b(you|your|yours|yourself)\b/gi, 'second person'],
  ['imperative_mood', /^\s*(do|go|make|build|run|stop|use|write|fix|try|check|ship|kill|remove|add)\b/gim, 'imperative mood'],
  ['firstperson_artifacts', /\b(i feel|i think|i want|i need|i hate|i love|i.m doing|i decided|my plan|my goal|my life)\b/gi, 'emotional self-reference'],
  ['self_meta', /\b(am i|why am i|do i|can i|should i|did i|have i)\b/gi, 'asks questions about himself'],
  ['identity_declare', /\b(my name is|i am \d\d|i.m \d\d|years old|call me)\b/gi, 'declares identity'],
];
const AI_META = [
  ['ai_consciousness', /\b(are you (a )?(conscious|alive|aware|sentient)|do you (feel|have feelings)|your feelings)\b/gi, 'probes agent mind/consciousness'],
  ['trust_check', /\b(do you (really )?(know|understand|remember)|you (don.t|do not) know)\b/gi, 'tests the agent'],
  ['pushback', /\b(you.re wrong|that.s not|stop saying|no[,.]? you|wrong)\b/gi, 'pushes back on the agent'],
  ['verbosity_pref', /\b(too long|be brief|short|concise|just the|one line|no preamble)\b/gi, 'asks for brevity'],
  ['do_it_pref', /\b(just do|do it|don.t ask|stop asking|without asking)\b/gi, 'asks for autonomous action'],
];

const DOMAINS = {
  magic: /\b(magic|occult|sigil|ritual|enochian|goetia|qabalah|cabala|rune|talisman|grimoire|incantation|spell|invocation|djinn|jinn|shaman|tarot|astrolog|occultism|mystic|ritual magic|chaos magic|sigil)\b/gi,
  code: /\b(code|coding|program|function|bug|api|repo|git|python|javascript|typescript|rust|golang|regex|script|compile|debug|refactor|stack trace)\b/gi,
  infra: /\b(server|linux|docker|kubernetes|deploy|hosting|cloudflare|nginx|ssh|firewall|network|database|postgres|redis|backup|domain|ssl|tls)\b/gi,
  ai_agents: /\b(agent|mcp|llm|opencode|claude|gemini|ollama|prompt|context window|token|embedding|rag|fine-?tune|system prompt|tool call)\b/gi,
  self: /\b(i feel|i'm tired|my life|my goal|my plan|depress|anxious|lonely|hopeless|meaning|purpose|existen|my health|sleep|my energy|myself)\b/gi,
  relationship: /\b(my (wife|girlfriend|partner|family|mother|father|brother|sister)|relationship|marriage|divorce|love|hate|breakup)\b/gi,
  money: /\b(money|salary|price|cost|rent|dollar|usd|toman|rial|income|budget|invest|debt|loan|bank)\b/gi,
  health: /\b(health|sick|pain|doctor|medicine|anxiety|depression|therapy|medication|workout|diet|weight)\b/gi,
  art: /\b(design|art|music|song|poem|write|writing|novel|story|drawing|photo|video|edit)\b/gi,
  learning: /\b(learn|study|book|read|course|english|persian|vocabulary|grammar|practice)\b/gi,
  philosophy: /\b(meaning|truth|reality|conscious|existence|god|religio|ethic|moral|absurd|nihilis|entropy|simulation)\b/gi,
  career: /\b(job|work|career|employer|office|boss|interview|resume|career path|workout)\b/gi,
};
const MAGIC_MECHANISM = /\b(reality|matrix|simulation|god.?s eye|frequency|vibration|energy|quantum|akashic|interdimensional|portal|ascend|awaken|manifest|collective unconscious|aether)\b/gi;

function eraOf(d) {
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
  if (y === 2023) return m <= 6 ? '2023H1' : '2023H2';
  return String(y);
}

function buildFeatures(texts) {
  const acc = {};
  const bump = (k) => { acc[k] = (acc[k] || 0) + 1; };
  let totalChars = 0, totalMsgs = 0, faMsgs = 0;
  const starters = new Map();
  for (const t of texts) {
    totalMsgs++; totalChars += t.length;
    if (isFa(t)) faMsgs++;
    for (const [, re, ] of [...DIRECT, ...TONE, ...IDENTITY, ...AI_META]) re.lastIndex = 0;
    for (const [name, re] of [...DIRECT, ...TONE, ...IDENTITY, ...AI_META]) { re.lastIndex = 0; if (re.test(t)) bump(name); }
    const first = words(t)[0];
    if (first && t.split(/\s+/).length < 12) starters.set(first, (starters.get(first) || 0) + 1);
  }
  return {
    totalMsgs, totalChars, faMsgs,
    faRatio: totalMsgs ? faMsgs / totalMsgs : 0,
    avgLen: totalMsgs ? totalChars / totalMsgs : 0,
    counts: acc,
    starters: [...starters.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
  };
}

function domainStats(userTexts) {
  const out = {};
  for (const [name, re] of Object.entries(DOMAINS)) { out[name] = { hits: 0, chars: 0, msgs: 0 }; }
  for (const t of userTexts) {
    for (const [name, re] of Object.entries(DOMAINS)) { re.lastIndex = 0; const m = t.match(re); if (m) { out[name].hits += m.length; out[name].msgs++; out[name].chars += t.length; } }
  }
  return out;
}

function phraseStats(userTexts) {
  const map = new Map();
  for (const t of userTexts) {
    const clean = t.replace(/\s+/g, ' ').toLowerCase();
    const ws = clean.match(/[\p{L}\p{N}']+/gu) || [];
    for (let n = 2; n <= 5; n++) {
      for (let i = 0; i + n <= ws.length; i++) {
        const g = ws.slice(i, i + n).join(' ');
        if (g.length < 8) continue;
        if (/^(the|a|an|and|or|to|of|in|is|it|you|that|this|i)\b/.test(g) && n === 2) continue; // skip trivial bigrams
        map.set(g, (map.get(g) || 0) + 1);
      }
    }
  }
  return [...map.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 60);
}

// ────────────────────────────────────────────────────────────────── gate ──
// gateClaim() is imported from lib.mjs (single source of truth with the server).

// ────────────────────────────────────────────────────────────────── main ──
function main() {
  const rebuild = process.argv.includes('--rebuild') || !fs.existsSync(DB_PATH);
  if (fs.existsSync(DB_PATH) && !rebuild) { log('DB exists, pass --rebuild to regenerate.'); return; }
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF;');
  db.exec(`
    CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE conversation (id TEXT PRIMARY KEY, title TEXT, create_ts REAL, update_ts REAL, n_msg INT, n_user INT, n_assistant INT, chars INT);
    CREATE TABLE message (id INTEGER PRIMARY KEY, conv_id TEXT, idx INT, role TEXT, ts REAL, text TEXT, len INT, fa INT);
    CREATE INDEX idx_msg_conv ON message(conv_id, idx);
    CREATE INDEX idx_msg_role ON message(role);
    CREATE VIRTUAL TABLE message_fts USING fts5(body, body_fa, tokenize="unicode61 remove_diacritics 2");
    CREATE TABLE episode (id INTEGER PRIMARY KEY, conv_id TEXT, title TEXT, user_msg_id INT, reply_first INT, reply_last INT, reply_n INT, ts REAL, fa INT);
    CREATE INDEX idx_ep_conv ON episode(conv_id);
    CREATE TABLE persona_trait (id INTEGER PRIMARY KEY, kind TEXT, name TEXT, statement TEXT, evidence TEXT, support INT, weight REAL);
    CREATE TABLE domain_stat (name TEXT PRIMARY KEY, hits INT, msgs INT, chars INT, share REAL);
    CREATE TABLE phrase (text TEXT PRIMARY KEY, n INT);
    CREATE TABLE atom (id INTEGER PRIMARY KEY, type TEXT, claim TEXT, quote TEXT, confidence TEXT, target TEXT, chunk TEXT, gate TEXT, source TEXT, verdict TEXT);
    CREATE TABLE gate_log (id INTEGER PRIMARY KEY, ts REAL, kind TEXT, subject TEXT, verdict TEXT, reason TEXT, payload TEXT); -- deprecated: audit log now lives in gate.db (owned by server.mjs) so --rebuild cannot destroy it
    CREATE TABLE pointer (id INTEGER PRIMARY KEY, tier TEXT, name TEXT, value TEXT, note TEXT);
  `);

  // ── load full raw export ──
  const files = fs.readdirSync(RAW_DIR).filter(f => /^conversations-\d+\.json$/.test(f)).sort();
  log('raw files:', files.length);
  const insConv = db.prepare('INSERT OR REPLACE INTO conversation VALUES (?,?,?,?,?,?,?,?)');
  const insMsg = db.prepare('INSERT INTO message (conv_id, idx, role, ts, text, len, fa) VALUES (?,?,?,?,?,?,?)');
  const insEpi = db.prepare('INSERT INTO episode (conv_id, title, user_msg_id, reply_first, reply_last, reply_n, ts, fa) VALUES (?,?,?,?,?,?,?,?)');
  const insFts = db.prepare('INSERT INTO message_fts (rowid, body, body_fa) VALUES (?,?,?)');

  const userTexts = []; const allUser = []; const eraUser = new Map();
  let nConv = 0, nMsg = 0, nUser = 0, nAsst = 0, nEpi = 0, totalChars = 0;
  const t0 = Date.now();

  db.exec('BEGIN;');
  for (const f of files) {
    let arr;
    try { arr = readJson(path.join(RAW_DIR, f), []); } catch { continue; }
    if (!Array.isArray(arr)) continue;
    let skipped = 0;
    for (const c of arr) {
      // NB: node must stay the node ID (string). Assigning the node object breaks the walk.
      const mp = c.mapping || {}; let node = c.current_node; const chain = [];
      while (node && mp[node]) { chain.push(mp[node]); node = mp[node].parent; }
      chain.reverse();
      if (!chain.length) { skipped++; continue; }
      const msgs = [];
      for (const nd of chain) {
        const m = nd.message; if (!m) continue;
        let ts = m.create_time; if (ts == null) continue; if (ts > 1e11) ts /= 1000;
        const role = (m.author || {}).role; if (role !== 'user' && role !== 'assistant') continue;
        const txt = extractText(m.content);
        if (!txt) continue;
        msgs.push({ role, ts, txt });
      }
      if (!msgs.length) continue;
      const id = c.conversation_id || c.id || `c${nConv}`;
      const faConv = msgs.filter(m => isFa(m.txt)).length;
      insConv.run(id, (c.title || '').slice(0, 300), c.create_time || msgs[0].ts, c.update_time || msgs[msgs.length - 1].ts, msgs.length, msgs.filter(m => m.role === 'user').length, msgs.filter(m => m.role === 'assistant').length, msgs.reduce((a, m) => a + m.txt.length, 0));
      nConv++;

      // Episode = one user turn + the assistant replies that follow it, up to the next user turn.
      let firstUserId = null, epTs = null, epFa = 0, epFirst = null, epLast = null, epRep = 0;
      const flushEpisode = () => {
        if (firstUserId == null) return;
        insEpi.run(id, (c.title || '').slice(0, 300), firstUserId, epFirst ?? firstUserId, epLast ?? firstUserId, epRep, epTs, epFa);
        nEpi++;
        firstUserId = null; epTs = null; epFa = 0; epFirst = null; epLast = null; epRep = 0;
      };
      for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i];
        const info = insMsg.run(id, i, m.role, m.ts, m.txt, m.txt.length, isFa(m.txt) ? 1 : 0);
        const mid = Number(info.lastInsertRowid);
        insFts.run(mid, m.txt, faNormalize(m.txt));
        nMsg++; totalChars += m.txt.length;
        if (m.role === 'user') {
          flushEpisode();
          firstUserId = mid; epTs = m.ts; epFa = isFa(m.txt) ? 1 : 0;
          userTexts.push(m.txt); allUser.push(m.txt);
          const era = eraOf(new Date(m.ts * 1000));
          if (!eraUser.has(era)) eraUser.set(era, []);
          eraUser.get(era).push(m.txt);
          nUser++;
        } else {
          nAsst++;
          if (firstUserId != null) { if (epFirst == null) epFirst = mid; epLast = mid; epRep++; }
        }
      }
      flushEpisode();
    }
    log(`  ${f}: ${skipped} empty-chain skipped`);
  }
  db.exec('COMMIT;');
  log(`ingested ${nConv} conv, ${nMsg} msg, ${nEpi} episodes, ${(totalChars / 1e6).toFixed(1)}M chars in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // ── link distill atoms ──
  const atomFiles = [];
  const atomsDir = path.join(DISTILL, 'atoms');
  if (fs.existsSync(atomsDir)) for (const f of fs.readdirSync(atomsDir)) if (f.endsWith('.json')) atomFiles.push(path.join(atomsDir, f));
  const insAtom = db.prepare('INSERT INTO atom (type, claim, quote, confidence, target, chunk, gate, source, verdict) VALUES (?,?,?,?,?,?,?,?,?)');
  const normClaim = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').replace(/[.,;:!?]+$/, '').trim();
  let nAtom = 0, dupAtoms = 0;
  // accepted.json is authoritative → load first, then only add atom-file claims it does not already cover.
  const acc = readJson(path.join(DISTILL, 'verified', 'accepted.json'), []);
  const seenClaims = new Set();
  if (Array.isArray(acc)) for (const a of acc) {
    const g = gateClaim(a.claim);
    insAtom.run(a.type || g.kind, a.claim, a.quote || '', a.confidence || 'high', a.target || 'smart-pill', a.chunk || '', a.gate || 'pass', 'distill-accepted', g.verdict);
    seenClaims.add(normClaim(a.claim));
    nAtom++;
  }
  for (const af of atomFiles) {
    const o = readJson(af, null); if (!o || !Array.isArray(o.atoms)) continue;
    for (const a of o.atoms) {
      const k = normClaim(a.claim);
      if (seenClaims.has(k)) { dupAtoms++; continue; }
      seenClaims.add(k);
      const g = gateClaim(a.claim);
      insAtom.run(a.type || g.kind, a.claim, a.quote || '', a.confidence || 'med', a.target || '', o.chunk_file || path.basename(af), g.verdict, 'distill-atoms', g.verdict);
      nAtom++;
    }
  }
  log('atoms linked:', nAtom, `(${dupAtoms} duplicates folded into accepted)`);

  // ── persona mining ──
  const feats = buildFeatures(userTexts);
  const doms = domainStats(userTexts);
  const phrases = phraseStats(userTexts);
  const insTrait = db.prepare('INSERT INTO persona_trait (kind, name, statement, evidence, support, weight) VALUES (?,?,?,?,?,?)');
  const push = (kind, name, statement, evidence, support) => insTrait.run(kind, name, statement, evidence, support, Math.min(1, support / 400));

  for (const [name, re, statement] of [...DIRECT, ...TONE, ...IDENTITY, ...AI_META]) {
    const support = feats.counts[name] || 0;
    const share = feats.totalMsgs ? support / feats.totalMsgs : 0;
    if (share > 0.005) push('pattern', name, statement, `matched in ${support}/${feats.totalMsgs} user msgs (${(share * 100).toFixed(1)}%)`, support);
  }
  push('metric', 'avg_len', `average user message length ${feats.avgLen.toFixed(0)} chars`, `${feats.totalMsgs} msgs`, feats.totalMsgs);
  push('metric', 'fa_ratio', `Persian share of user msgs ${(feats.faRatio * 100).toFixed(0)}%`, `${feats.faMsgs} fa msgs`, feats.totalMsgs);
  if (feats.starters.length) push('stylometry', 'openers', `top short-message openers: ${feats.starters.map(([w, n]) => w + '×' + n).join(', ')}`, 'stylometric', feats.starters.reduce((a, [, n]) => a + n, 0));

  const totalHits = Object.values(doms).reduce((a, d) => a + d.hits, 0) || 1;
  const insDom = db.prepare('INSERT OR REPLACE INTO domain_stat VALUES (?,?,?,?,?)');
  for (const [name, d] of Object.entries(doms)) insDom.run(name, d.hits, d.msgs, d.chars, d.hits / totalHits);
  push('preference', 'domain_focus', `top domains: ${Object.entries(doms).sort((a, b) => b[1].hits - a[1].hits).slice(0, 4).map(([n, d]) => `${n} (${(100 * d.hits / totalHits).toFixed(0)}%)`).join(', ')}`, 'domain lexicon', Object.values(doms).reduce((a, d) => a + d.hits, 0));

  const insPh = db.prepare('INSERT OR REPLACE INTO phrase VALUES (?,?)');
  for (const [p, n] of phrases) insPh.run(p, n);
  push('preference', 'catchphrases', `recurring verbatim phrases (≥3×): ${phrases.slice(0, 8).map(([p, n]) => `"${p}"×${n}`).join('; ')}`, 'n-gram mining', phrases.reduce((a, [, n]) => a + n, 0));

  // era drift in directness
  for (const [era, list] of [...eraUser.entries()].sort()) {
    const ef = buildFeatures(list);
    const dir = (ef.counts.bare_imperative || 0) + (ef.counts.delegate || 0) + (ef.counts.yes_ok || 0);
    push('era', era, `era ${era}: ${ef.totalMsgs} msgs, avg ${ef.avgLen.toFixed(0)} chars, direct-markers ${(100 * dir / (ef.totalMsgs || 1)).toFixed(0)}%, fa ${(ef.faRatio * 100).toFixed(0)}%`, 'era slice', ef.totalMsgs);
  }

  // ── L0 pointers (proposal-only; NEVER written to AGENTS) ──
  const insPtr = db.prepare('INSERT INTO pointer (tier, name, value, note) VALUES (?,?,?,?)');
  insPtr.run('L0', 'language', 'answer in the language he writes in', 'behavioral, from operator profile');
  insPtr.run('L0', 'tone', 'informal, direct, no polite filler', 'behavioral');
  insPtr.run('L0', 'autonomy', 'recommend one option, then act; ask only when reversal is expensive', 'behavioral');
  insPtr.run('L0', 'correction', 'absorb flat corrections, no apology loop', 'behavioral');
  insPtr.run('L0', 'status', 'give position, not diary', 'behavioral');
  insPtr.run('L1', 'magic_thesis', 'magic = door scanner; sigil/name/tone = barcode; intent = auth; ritual = protocol', 'from SymbolicOS — symbolic/ritual framing only, no mechanism claim');
  insPtr.run('L1', 'build_order', 'reverse-engineer → ritual-as-auth-protocol prototype → personal mapping → custom OS', 'from SymbolicOS');
  insPtr.run('L1', 'source_priority', 'Enochian → Goetia → Qabalah → Norse runes → Egyptian → Vedic/Tantra → Chaos Magic', 'from SymbolicOS');
  insPtr.run('L2', 'episodes', 'conversations', 'retrieve via soul_episode');
  insPtr.run('L3', 'corpus', `${nConv} conversations / ${nMsg} messages`, 'FTS5 hybrid retrieval');

  const meta = { built: new Date().toISOString(), nConv: String(nConv), nMsg: String(nMsg), nUser: String(nUser), nAsst: String(nAsst), nEpi: String(nEpi), totalChars: String(totalChars), nAtom: String(nAtom), nPersonaTraits: String(db.prepare('SELECT COUNT(*) c FROM persona_trait').get().c) };
  const insMeta = db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)');
  for (const [k, v] of Object.entries(meta)) insMeta.run(k, v);

  db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  const counts = { conv: nConv, msg: nMsg, epi: nEpi, atoms: nAtom, traits: meta.nPersonaTraits, fts: nMsg };
  console.log('[ingest] DONE', JSON.stringify(counts));
  db.close();
}

main();
