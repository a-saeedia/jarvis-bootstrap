#!/usr/bin/env node
/**
 * server.mjs — Soul MCP server (zero dependency, prompt/retrieval only).
 *
 * Transport: line-delimited JSON-RPC 2.0 over stdio (MCP stdio framing).
 * Storage:   local SQLite via node:sqlite (Node >= 22.5).
 *              - soul.db  opened READ-ONLY. The corpus is physically immutable
 *                         from this process; a bug here cannot corrupt it.
 *              - gate.db  opened read-write. Holds the ONLY table this server
 *                         may write (gate_log). Kept in a separate file so
 *                         `ingest.mjs --rebuild` can never destroy the audit
 *                         trail.
 * Scope:     Never edits AGENTS.md, opencode.jsonc, or any other config.
 *
 * Run:  node server.mjs            (stdio; one JSON-RPC message per line)
 *       node server.mjs --selftest (fixtures + latency, prints JSON)
 *       node server.mjs --dump     (offline smoke: exercises every tool)
 *
 * Design rules:
 *   - Persona/voice mining reads ONLY user turns (+ accepted atoms). Assistant
 *     prose is never a persona source.
 *   - Retrieval is bilingual and Persian-safe: query and body go through the
 *     same faNormalize (lib.mjs), and both `body` and `body_fa` are matched.
 *   - The gate (gateClaim) is imported from lib.mjs — the same function the
 *     corpus builder used, so claims can never be graded two different ways.
 */
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  faNormalize, isFa, gateClaim, buildMatch, clip, iso, nowSec, numOrNull, clampNum,
} from './lib.mjs';

// Silence node:sqlite's ExperimentalWarning so it cannot pollute a client's
// stderr view. SOUL_DEBUG=1 re-enables it.
const DEBUG = !!process.env.SOUL_DEBUG;
process.removeAllListeners('warning');
if (DEBUG) process.on('warning', (w) => process.stderr.write(`[soul][warn] ${w.message}\n`));

// ── config ────────────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.SOUL_DB || join(__dirname, 'soul.db');
const GATE_PATH = process.env.SOUL_GATE_DB || join(__dirname, 'gate.db');
const PROTO_DEFAULT = '2025-06-18';
const PROTO_SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];
const RECALL_K_MAX = 20;
const VERDICTS = ['pass', 'quarantine', 'reject', 'review'];

// ── corpus handle: read-only, guarded ─────────────────────────────────────
let db = null;
const P = {};
function openDb() {
  if (db) return db;
  db = new DatabaseSync(DB_PATH, { readOnly: true });
  db.exec('PRAGMA query_only=ON;');
  P.counts = db.prepare(`SELECT
      (SELECT COUNT(*) FROM conversation) conv,
      (SELECT COUNT(*) FROM message)     msg,
      (SELECT COUNT(*) FROM episode)     epi,
      (SELECT COUNT(*) FROM message_fts) fts,
      (SELECT COUNT(*) FROM persona_trait) traits,
      (SELECT COUNT(*) FROM atom)        atoms,
      (SELECT COUNT(*) FROM atom WHERE gate='pass' AND verdict<>'reject') atoms_ok,
      (SELECT SUM(len) FROM message)         AS chars`);
  P.meta = db.prepare('SELECT k, v FROM meta');
  P.recall = db.prepare(`
    SELECT m.id, m.conv_id, m.idx, m.role, m.ts, m.len, m.fa, m.text,
           bm25(message_fts, 1.0, 0.6) AS score
    FROM message_fts f
    JOIN message m ON m.id = f.rowid
    WHERE message_fts MATCH ?
      AND (? IS NULL OR m.role = ?)
      AND (? IS NULL OR m.fa = ?)
      AND (? IS NULL OR m.len >= ?)
      AND (? IS NULL OR m.ts >= ?)
      AND (? IS NULL OR m.ts <= ?)
    ORDER BY score
    LIMIT ?`);
  P.persona = db.prepare(`SELECT kind, name, statement, evidence, support, weight
    FROM persona_trait ORDER BY weight DESC, support DESC LIMIT ?`);
  P.phrases = db.prepare('SELECT text, n FROM phrase ORDER BY n DESC LIMIT ?');
  P.domains = db.prepare('SELECT name, hits, msgs, chars, share FROM domain_stat ORDER BY hits DESC LIMIT ?');
  P.epByConv = db.prepare(`SELECT e.id, e.conv_id, e.title, e.user_msg_id, e.reply_first, e.reply_last,
      e.reply_n, e.ts, e.fa
    FROM episode e WHERE e.conv_id = ? ORDER BY e.id LIMIT ?`);
  P.epById = db.prepare(`SELECT e.id, e.conv_id, e.title, e.user_msg_id, e.reply_first, e.reply_last,
      e.reply_n, e.ts, e.fa
    FROM episode e WHERE e.id = ?`);
  P.msgById = db.prepare('SELECT id, conv_id, idx, role, ts, len, fa, text FROM message WHERE id = ?');
  P.convById = db.prepare('SELECT id, title, create_ts, update_ts, n_msg, n_user, n_assistant, chars FROM conversation WHERE id = ?');
  // `gate` is the distill pipeline's admission decision (authoritative).
  // `verdict` is this runtime gate's re-check. Accepted distill atoms are
  // third-person claims, so the first-person FACT regexes rate them 'review' —
  // filtering on `verdict='pass'` would return zero rows and hide the corpus.
  P.atoms = db.prepare(`SELECT id, type, claim, quote, confidence, target, chunk, gate, source, verdict
    FROM atom WHERE gate = 'pass' AND verdict <> 'reject' ORDER BY id LIMIT ?`);
  P.atomById = db.prepare("SELECT id, type, claim, quote, confidence, target, chunk, gate, source, verdict FROM atom WHERE id = ? AND gate = 'pass' AND verdict <> 'reject'");
  // Held tier: recorded claims the distill pipeline did NOT admit. These are
  // deliberately not authority (asserting them about the user would bypass the
  // admission gate) but they are the load-bearing material - crisis history,
  // the assistant-derailing gotcha. Silently hiding them produced a cheerful
  // persona with no memory of the failures, so they are returned in their own
  // clearly-labelled section. Never merge them into `atoms`.
  // NULL-safe: a NULL gate means the distill pipeline never decided, which is
  // "not admitted" — it must land in held, never vanish.
  const HELD_PRED = "(gate IS NULL OR gate <> 'pass') AND (verdict IS NULL OR verdict <> 'reject')";
  P.atomsHeld = db.prepare(`SELECT id, type, claim, quote, confidence, target, chunk, gate, source, verdict
    FROM atom WHERE ${HELD_PRED} ORDER BY id LIMIT ?`);
  P.atomHeldById = db.prepare(`SELECT id, type, claim, quote, confidence, target, chunk, gate, source, verdict
    FROM atom WHERE id = ? AND ${HELD_PRED}`);
  P.atomsHeldCount = db.prepare(`SELECT COUNT(*) c FROM atom WHERE ${HELD_PRED}`);
  P.atomsAuthCount = db.prepare("SELECT COUNT(*) c FROM atom WHERE gate = 'pass' AND verdict <> 'reject'");
  P.pointers = db.prepare('SELECT tier, name, value, note FROM pointer ORDER BY tier, name');
  P.epRange = db.prepare('SELECT MIN(ts) a, MAX(ts) b FROM message WHERE ts IS NOT NULL');
  return db;
}

// ── audit handle: the ONLY write path in this process ─────────────────────
let gate = null;
const G = {};
function openGate() {
  if (gate) return gate;
  gate = new DatabaseSync(GATE_PATH);
  gate.exec('PRAGMA busy_timeout=5000;');
  gate.exec('PRAGMA journal_mode=WAL;');
  gate.exec('CREATE TABLE IF NOT EXISTS gate_log (id INTEGER PRIMARY KEY, ts REAL, kind TEXT, subject TEXT, verdict TEXT, reason TEXT, payload TEXT)');
  gate.exec('CREATE INDEX IF NOT EXISTS idx_gate_ts ON gate_log(ts)');
  gate.exec('PRAGMA query_only=ON;');
  G.insert = gate.prepare('INSERT INTO gate_log (ts, kind, subject, verdict, reason, payload) VALUES (?,?,?,?,?,?)');
  G.tail = gate.prepare('SELECT id, ts, kind, subject, verdict, reason, payload FROM gate_log ORDER BY id DESC LIMIT ?');
  G.byId = gate.prepare('SELECT id, ts, kind, subject, verdict, reason, payload FROM gate_log WHERE id = ?');
  G.maxId = gate.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM gate_log');
  G.count = gate.prepare('SELECT COUNT(*) AS n FROM gate_log');
  G.deleteAfter = gate.prepare('DELETE FROM gate_log WHERE id > ?');
  return gate;
}

/** Run `fn` with the audit log briefly unlocked. The ONLY mutation path. */
function withWrite(fn) {
  openGate();
  gate.exec('PRAGMA query_only=OFF;');
  try { return fn(); } finally { gate.exec('PRAGMA query_only=ON;'); }
}
function gateCounts() {
  openGate();
  return { rows: G.count.get().n, max_id: G.maxId.get().m, db: GATE_PATH };
}

// ── soul_ping ─────────────────────────────────────────────────────────────
function soulPing() {
  const t0 = performance.now();
  openDb();
  openGate();
  const c = P.counts.get();
  return {
    ok: true, db: DB_PATH, gate_db: GATE_PATH,
    messages: c.msg, conversations: c.conv, episodes: c.epi, atoms_accepted: c.atoms_ok,
    gate_rows: G.count.get().n,
    latency_ms: +(performance.now() - t0).toFixed(2),
  };
}

// ── soul_ladder ───────────────────────────────────────────────────────────
function soulLadder() {
  openDb();
  const c = P.counts.get();
  const meta = {};
  for (const r of P.meta.all()) meta[r.k] = r.v;
  const range = P.epRange.get();
  return {
    corpus: {
      conversations: c.conv, messages: c.msg, episodes: c.epi,
      user_messages: Number(meta.nUser), assistant_messages: Number(meta.nAsst),
      chars: c.chars, fts_rows: c.fts, persona_traits: c.traits,
      atoms: c.atoms, atoms_accepted: c.atoms_ok,
    },
    range: { first: iso(range.a), last: iso(range.b) },
    built: meta.built,
    ladder: [
      'raw files → mapping-tree nodes → text/audio-extracted → user|assistant → FTS body|body_fa',
      'thoughts + reasoning_recap + asset-only nodes excluded (model internals, not user voice)',
      'persona/phrase/domain mining reads user turns ONLY',
    ],
    rules: {
      persona_source: 'user turns + accepted atoms only (never assistant prose)',
      writes: 'gate_log only, in gate.db; AGENTS.md is never written',
      training: 'NONE. No weights are touched — this is retrieval, not fine-tuning.',
      network: 'none',
    },
  };
}

// ── soul_recall ───────────────────────────────────────────────────────────
function soulRecall(a) {
  openDb();
  const query = String(a.query == null ? '' : a.query);
  if (!query.trim()) return { error: 'query required', query, hits: [] };
  const lang = ['any', 'fa', 'en'].includes(a.lang) ? a.lang : 'any';
  const k = clampNum(a.k, 1, RECALL_K_MAX, 5);
  const role = a.role === 'user' || a.role === 'assistant' ? a.role : null;
  const faFlag = lang === 'fa' ? 1 : lang === 'en' ? 0 : null;
  const minLen = numOrNull(a.min_len);
  const from = numOrNull(a.since_ts);
  const to = numOrNull(a.until_ts);
  const snippet = clampNum(a.snippet, 40, 4000, 600);

  // Query variants: raw, Persian-normalized, and (for Persian) the original
  // again so the Latin column still gets a shot. Deduped.
  const variants = [...new Set([query, faNormalize(query), ...(isFa(query) ? [query] : [])])];

  const seen = new Set();
  const hits = [];
  for (const q of variants) {
    const match = buildMatch(q);
    if (!match) continue;
    const rows = P.recall.all(match, role, role, faFlag, faFlag, minLen, minLen, from, from, to, to, k);
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      hits.push({
        msg_id: r.id, conv_id: r.conv_id, idx: r.idx, role: r.role,
        ts: iso(r.ts), len: r.len, fa: !!r.fa, score: Number(r.score.toFixed(3)),
        text: clip(r.text, snippet),
      });
    }
  }
  hits.sort((x, y) => x.score - y.score);   // bm25: more negative = better
  const out = hits.slice(0, k);
  return {
    query, lang, role: role || 'any', k: out.length,
    best_score: out.length ? out[0].score : null,
    hits: out,
  };
}

// ── soul_persona ──────────────────────────────────────────────────────────
function soulPersona(a) {
  openDb();
  const k = clampNum(a.k, 1, 200, 60);
  const kinds = Array.isArray(a.kinds) && a.kinds.length ? a.kinds.map(String) : null;
  let traits = P.persona.all(kinds ? Math.min(400, k * 6) : k);
  if (kinds) traits = traits.filter((r) => kinds.includes(r.kind)).slice(0, k);
  let phrases = P.phrases.all(k);
  let domains = P.domains.all(k);
  if (a.q) {
    const f = faNormalize(a.q);
    const hit = (s) => faNormalize(s).includes(f) || String(s).includes(a.q);
    traits = traits.filter((r) => hit(r.statement) || hit(r.name) || hit(r.evidence));
    phrases = phrases.filter((r) => hit(r.text));
    domains = domains.filter((r) => hit(r.name));
  }
  return {
    source: 'user turns only; assistant prose excluded by construction',
    filters: { k, kinds, q: a.q || null },
    traits, phrases, domains,
  };
}

// ── soul_atoms ────────────────────────────────────────────────────────────
// Gate-segregated read. The admission gate (`gate='pass'`) is deliberately kept
// narrow: the agent must not assert things about the user that the distill
// pipeline never admitted. But 18 of 41 atoms are held back that way, and they
// include the load-bearing material — the recorded assistant-derailing gotcha,
// the crisis history, the sigil artifact lineage. Returning only the 23
// authoritative atoms produced a confident persona with no memory of its own
// recorded failures. So the held tier is READABLE and separately labelled.
// It is never merged into `atoms` and never treated as authority.
const HELD_WARNING = 'HELD TIER: these claims were NOT admitted by the distill gate (gate != pass). Read them as recorded history and behavioral guidance. Do NOT assert them as established fact about the user, and do NOT write them into AGENTS.md — use soul_propose/soul_admit, which write only to gate.db.';
const HELD_HINT = 'held claims are readable: soul_atoms {tier:"held"} or {tier:"all"}. They are recorded history, not authority.';
const ATOM_TIERS = new Set(['authoritative', 'held', 'all']);

function soulAtoms(a) {
  openDb();
  const tier = ATOM_TIERS.has(a.tier) ? a.tier : 'authoritative';

  // Single-atom lookup: authoritative first, then held, never merged.
  if (a.id != null) {
    const id = Number(a.id);
    if (!Number.isInteger(id)) return { error: 'atom id must be an integer', id: a.id };
    const auth = P.atomById.get(id);
    if (auth) return { tier: 'authoritative', count: 1, atoms: [auth] };
    const held = P.atomHeldById.get(id);
    if (held) return { tier: 'held', count: 1, atoms: [held], held_warning: HELD_WARNING };
    // Distinguish "never existed" from "exists but not readable (rejected)".
    const seen = db.prepare('SELECT id, gate, verdict FROM atom WHERE id = ?').get(id);
    if (seen) return { error: 'atom exists but is not readable (rejected)', id, gate: seen.gate, verdict: seen.verdict };
    return { error: 'atom not found', id };
  }

  const k = clampNum(a.k, 1, 200, 50);
  const authCount = P.atomsAuthCount.get().c;
  const heldCount = P.atomsHeldCount.get().c;
  const out = {
    tier,
    count: 0,
    authoritative_count: authCount,
    held_count: heldCount,
    held_hint: heldCount > 0 ? HELD_HINT : 'no held claims',
    policy: 'gate = distill admission (authoritative); verdict = runtime gate re-check. third-person distill claims rate verdict=review by design.',
  };
  if (tier === 'held') {
    out.atoms = P.atomsHeld.all(k);
    out.held_warning = HELD_WARNING;
  } else {
    // authoritative, or all — `atoms` stays authoritative, `held` is a
    // separate labelled section. The two tiers are never merged.
    out.atoms = P.atoms.all(k);
    if (tier === 'all') {
      out.held = P.atomsHeld.all(k);
      out.held_warning = HELD_WARNING;
    }
  }
  out.count = out.atoms.length;
  const total = tier === 'held' ? heldCount : tier === 'all' ? authCount + heldCount : authCount;
  out.truncated = out.count < total;
  return out;
}

// ── soul_episode ──────────────────────────────────────────────────────────
function soulEpisode(a) {
  openDb();
  const limit = clampNum(a.limit, 1, 50, 10);
  const replyChars = clampNum(a.reply_chars, 0, 20000, 2000);
  const userChars = clampNum(a.user_chars, 0, 20000, 2000);

  const pick = (row) => {
    const q = P.msgById.get(row.user_msg_id);
    const r1 = row.reply_first ? P.msgById.get(row.reply_first) : null;
    const r2 = row.reply_last ? P.msgById.get(row.reply_last) : null;
    return {
      ep_id: row.id, conv_id: row.conv_id, title: row.title,
      ts: iso(row.ts), fa: !!row.fa, reply_n: row.reply_n,
      reply_first_idx: r1 ? r1.idx : null, reply_last_idx: r2 ? r2.idx : null,
      user: q ? { msg_id: q.id, idx: q.idx, ts: iso(q.ts), text: clip(q.text, userChars) } : null,
      reply_head: r1 ? clip(r1.text, replyChars) : '',
      reply_tail: r2 && (!r1 || r2.id !== r1.id) ? clip(r2.text, Math.floor(replyChars / 2)) : '',
    };
  };

  if (a.ep_id != null) {
    const row = P.epById.get(Number(a.ep_id));
    if (!row) return { error: 'episode not found', ep_id: a.ep_id };
    return { episodes: [pick(row)] };
  }
  if (a.conv_id) {
    const convId = String(a.conv_id);
    const rows = P.epByConv.all(convId, limit);
    const conv = P.convById.get(convId);
    return {
      conv: conv
        ? { id: conv.id, title: conv.title, n_msg: conv.n_msg, n_user: conv.n_user, n_assistant: conv.n_assistant, chars: conv.chars }
        : null,
      episodes: rows.map(pick),
    };
  }
  const meta = {}; for (const r of P.meta.all()) meta[r.k] = r.v;
  return {
    corpus: { messages: Number(meta.nMsg), episodes: Number(meta.nEpi) },
    note: 'pass conv_id or ep_id to read one conversation',
  };
}

// ── soul_propose / soul_admit (gate.db is the only write target) ───────────
function soulPropose(a) {
  const claim = String(a.claim == null ? '' : a.claim);
  if (!claim.trim()) return { error: 'claim required' };
  openDb();
  const subject = String(a.subject || claim.slice(0, 120));
  const g = gateClaim(claim);
  const payload = JSON.stringify({ claim, note: a.note || null, kind: a.kind || null, proposed_at: new Date().toISOString() });
  const info = withWrite(() => G.insert.run(nowSec(), a.kind || 'claim', subject, 'proposed', 'awaiting admission', payload));
  return {
    proposed: true, gate_id: Number(info.lastInsertRowid),
    auto_verdict: g.verdict, auto_reason: g.reason, auto_kind: g.kind,
    log: gateCounts(),
    note: 'logged to gate.db gate_log; AGENTS.md and the corpus are never written',
  };
}
function soulAdmit(a) {
  openDb();
  openGate();
  const decision = VERDICTS.includes(a.verdict) ? a.verdict : null;
  if (!decision) return { error: `verdict required (one of: ${VERDICTS.join(', ')})` };
  let row = null;
  const gateId = a.gate_id != null ? Number(a.gate_id) : null;
  if (gateId != null) {
    row = G.byId.get(gateId);
    if (!row) return { error: 'gate_id not found', gate_id: gateId };
  }
  const subject = a.subject || (row ? row.subject : String(a.claim || '').slice(0, 120));
  if (!subject) return { error: 'subject or claim required' };
  const reason = a.reason || 'manual admission decision';
  const payload = JSON.stringify({ source_gate_id: gateId, claim: a.claim || null, decided_at: new Date().toISOString() });
  const info = withWrite(() => G.insert.run(nowSec(), 'admission', subject, decision, reason, payload));
  return {
    admitted: true, gate_id: Number(info.lastInsertRowid), decision, subject, reason,
    log: gateCounts(),
    note: 'logged to gate.db gate_log; AGENTS.md and the corpus are never written',
  };
}

// ── tool + resource descriptors ───────────────────────────────────────────
const TOOLS = [
  { name: 'soul_ping', description: 'Soul DB health: corpus path, counts, gate-log path, latency.', props: {} },
  { name: 'soul_ladder', description: 'Corpus ladder: counts, date range, extraction rules, write/training policy.', props: {} },
  {
    name: 'soul_recall',
    description: 'Bilingual (EN/FA) FTS recall over the whole conversation corpus. Normalizes Persian (ZWNJ, yeh/kaf variants) and matches both raw and normalized columns. Retrieval only — no training.',
    props: {
      query: { type: 'string', description: 'search text, EN or FA' },
      k: { type: 'number', description: `1..${RECALL_K_MAX}` },
      lang: { type: 'string', enum: ['any', 'fa', 'en'] },
      role: { type: 'string', enum: ['any', 'user', 'assistant'] },
      min_len: { type: 'number' }, since_ts: { type: 'number' }, until_ts: { type: 'number' },
      snippet: { type: 'number', description: 'chars per hit' },
    },
    required: ['query'],
  },
  {
    name: 'soul_persona',
    description: 'Persona/voice: traits, catchphrases, domains — mined from USER turns only. Assistant prose is never a source.',
    props: {
      k: { type: 'number' }, q: { type: 'string' },
      kinds: { type: 'array', items: { type: 'string' } },
    },
  },
  {
    name: 'soul_atoms',
    description: 'Distilled claims about the user (atom), split by admission tier. `authoritative` (default) = the distill gate admitted them. `held` = recorded claims the gate did NOT admit: readable as history and behavioral guidance, never as fact about the user, never written to AGENTS.md. `all` returns both, kept in separate sections.',
    props: {
      id: { type: 'number' },
      k: { type: 'number' },
      tier: { type: 'string', enum: ['authoritative', 'held', 'all'] },
    },
  },
  {
    name: 'soul_episode',
    description: 'Read a conversation episode: the user turn plus assistant reply head/tail. Needs conv_id or ep_id.',
    props: {
      conv_id: { type: 'string' }, ep_id: { type: 'number' },
      limit: { type: 'number' }, user_chars: { type: 'number' }, reply_chars: { type: 'number' },
    },
  },
  {
    name: 'soul_propose',
    description: 'Log a proposed claim to the audit log with an automatic gate verdict. Never writes AGENTS.md or the corpus.',
    props: {
      claim: { type: 'string' }, subject: { type: 'string' },
      note: { type: 'string' }, kind: { type: 'string' },
    },
    required: ['claim'],
  },
  {
    name: 'soul_admit',
    description: 'Record an admission decision (pass/quarantine/reject/review) to the audit log. Never writes AGENTS.md or the corpus.',
    props: {
      gate_id: { type: 'number' },
      verdict: { type: 'string', enum: VERDICTS },
      subject: { type: 'string' }, claim: { type: 'string' }, reason: { type: 'string' },
    },
    required: ['verdict'],
  },
];

const RESOURCES = [
  { uri: 'soul://ladder', name: 'ladder', title: 'Corpus ladder', description: 'Counts, range, extraction + write policy.', mimeType: 'application/json' },
    { uri: 'soul://profile', name: 'profile', title: 'Operator profile', description: 'Persona summary: L0 behavioral pointers, traits, top phrases, top domains (user turns only).', mimeType: 'application/json' },
  { uri: 'soul://persona', name: 'persona', title: 'Persona (user turns only)', description: 'Full persona block.', mimeType: 'application/json' },
    { uri: 'soul://atoms', name: 'atoms', title: 'Atoms (authoritative + held)', description: 'Distilled claims about the user, split by admission tier: `atoms` = authoritative, `held` = not admitted (recorded history, not authority).', mimeType: 'application/json' },
  { uri: 'soul://pointers', name: 'pointers', title: 'Pointer tiers', description: 'L0-L3 behavioural/thematic pointers (proposal-only, never written to AGENTS.md).', mimeType: 'application/json' },
  { uri: 'soul://gate', name: 'gate', title: 'Recent gate_log entries', description: 'Tail of the audit log.', mimeType: 'application/json' },
];

// ── dispatch ──────────────────────────────────────────────────────────────
function callTool(name, args) {
  switch (name) {
    case 'soul_ping': return soulPing();
    case 'soul_ladder': return soulLadder();
    case 'soul_recall': return soulRecall(args || {});
    case 'soul_persona': return soulPersona(args || {});
    case 'soul_atoms': return soulAtoms(args || {});
    case 'soul_episode': return soulEpisode(args || {});
    case 'soul_propose': return soulPropose(args || {});
    case 'soul_admit': return soulAdmit(args || {});
    default: { const e = new Error(`unknown tool: ${name}`); e.rpcCode = -32602; throw e; }
  }
}
function readResource(uri) {
  switch (uri) {
    case 'soul://ladder': return soulLadder();
    case 'soul://profile': {
      const p = soulPersona({ k: 40 });
      const t = p.traits.slice(0, 12).map((r) => ({ kind: r.kind, name: r.name, statement: r.statement }));
      return {
        source: p.source,
        note: 'user turns only; this is retrieval, not training',
        // L0 rides along here on purpose: behavioral doctrine must be readable
        // from the profile an agent loads first, not only from soul://pointers.
        l0_pointers: P.pointers.all().filter((r) => r.tier === 'L0').map((r) => ({ name: r.name, value: r.value })),
        traits: t,
        top_phrases: p.phrases.slice(0, 10),
        top_domains: p.domains.slice(0, 10),
      };
    }
    case 'soul://persona': return soulPersona({ k: 60 });
    case 'soul://atoms': return soulAtoms({ k: 100, tier: 'all' });
    case 'soul://pointers': { openDb(); return { pointers: P.pointers.all() }; }
    case 'soul://gate': { openGate(); return { log: gateCounts(), recent: G.tail.all(20) }; }
    default: { const e = new Error(`unknown resource: ${uri}`); e.rpcCode = -32602; throw e; }
  }
}

function handle(msg) {
  const { id, method, params } = msg || {};
  const isReq = id !== undefined && id !== null;
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, m) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message: String(m) } });
  if (!isReq) return null;                 // notification: never answered

  switch (method) {
    case 'initialize': {
      const asked = params && params.protocolVersion;
      const proto = PROTO_SUPPORTED.includes(asked) ? asked : PROTO_DEFAULT;
      return reply({
        protocolVersion: proto,
        capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } },
        serverInfo: { name: 'soul', version: '0.2.0' },
      });
    }
    case 'ping': return reply({});
    case 'tools/list':
      return reply({
        tools: TOOLS.map((t) => ({
          name: t.name, description: t.description,
          inputSchema: {
            type: 'object',
            properties: t.props,
            required: t.required || [],
            additionalProperties: false,
          },
        })),
      });
    case 'tools/call': {
      const out = callTool(params.name, params.arguments || {});
      const isErr = !!(out && out.error);
      return reply({
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        isError: isErr,
      });
    }
    case 'resources/list': return reply({ resources: RESOURCES });
    case 'resources/read': {
      const data = readResource(params.uri);
      return reply({ contents: [{ uri: params.uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] });
    }
    case 'prompts/list': return reply({ prompts: [] });
    default: return fail(-32601, `method not found: ${method}`);
  }
}

// ── stdio loop ────────────────────────────────────────────────────────────
function serve() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); }
      catch {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n');
        continue;
      }
      let out;
      try { out = handle(msg); }
      catch (e) {
        out = {
          jsonrpc: '2.0', id: msg && msg.id != null ? msg.id : null,
          error: { code: Number.isInteger(e.rpcCode) ? e.rpcCode : -32603, message: e && e.message ? e.message : String(e) },
        };
      }
      if (out) process.stdout.write(JSON.stringify(out) + '\n');
    }
  });
  process.stdin.on('end', () => { try { db && db.close(); gate && gate.close(); } catch {} process.exit(0); });
  process.on('uncaughtException', (e) => process.stderr.write(`[soul] ${e && e.stack}\n`));
  process.on('unhandledRejection', (e) => process.stderr.write(`[soul] ${e}\n`));
}

// ── selftest: every tool + the audit log, rolled back to zero rows ─────────
function selftest() {
  const out = { started: new Date().toISOString() };
  const time = (label, fn) => {
    const t = performance.now();
    try { out[label] = { ok: true, ms: +(performance.now() - t).toFixed(2), result: fn() }; }
    catch (e) { out[label] = { ok: false, error: e.message }; }
  };

  const before = gateCounts();
  time('ping', () => soulPing());
  time('ladder', () => soulLadder().corpus);
  time('recall_en', () => soulRecall({ query: 'agent memory persistent', k: 3 }).hits.map((h) => h.msg_id));
  time('recall_fa', () => soulRecall({ query: 'حافظه دائمی', k: 3 }).hits.map((h) => h.msg_id));
  time('recall_zwnj', () => soulRecall({ query: 'نرم‌افزار', k: 3 }).hits.map((h) => h.msg_id));
  time('recall_injection', () => { try { soulRecall({ query: 'foo" OR bar NEAR(', k: 2 }); return 'safe'; } catch (e) { return 'threw: ' + e.message; } });
  time('recall_role_user', () => soulRecall({ query: 'the ritual', k: 5, role: 'user' }).hits.every((h) => h.role === 'user'));
  time('persona', () => soulPersona({ k: 5 }).traits.map((t) => t.name));
  time('atoms', () => soulAtoms({ k: 5 }).count);
  // Gate blind-spot regression. The held tier (claims the distill gate did not
  // admit) must be reachable, labelled, and never merged into `atoms`.
  time('atoms_tiers', () => {
    const auth = soulAtoms({ k: 200 });
    const held = soulAtoms({ k: 200, tier: 'held' });
    const all = soulAtoms({ k: 200, tier: 'all' });
    return {
      auth_count: auth.count,
      held_count: auth.held_count,
      tiers_sum: auth.authoritative_count + auth.held_count,
      default_is_authoritative: auth.atoms.every((r) => r.gate === 'pass'),
      default_advertises_held: typeof auth.held_hint === 'string' && auth.held_hint.includes('held'),
      held_all_held: held.atoms.length > 0 && held.atoms.every((r) => r.gate !== 'pass'),
      held_has_warning: typeof held.held_warning === 'string',
      all_atoms_auth_only: all.atoms.every((r) => r.gate === 'pass'),
      all_held_separate: Array.isArray(all.held) && all.held.length > 0 && all.held.every((r) => r.gate !== 'pass'),
      never_merged: all.atoms.length === auth.atoms.length,
      id_held_tier: soulAtoms({ id: held.atoms[0].id }).tier === 'held',
      id_auth_tier: soulAtoms({ id: auth.atoms[0].id }).tier === 'authoritative',
      missing_id: soulAtoms({ id: -1 }).error,
      bad_tier_falls_back: soulAtoms({ k: 2, tier: 'bogus' }).tier === 'authoritative',
    };
  });
  time('res_atoms', () => { const r = readResource('soul://atoms'); return { atoms: r.atoms.length, held: (r.held || []).length, warning: !!r.held_warning }; });
  time('pointers_l0', () => readResource('soul://pointers').pointers.filter((p) => p.tier === 'L0').map((p) => p.name).sort());
  time('ep_none', () => soulEpisode({}));
  time('ep_conv', () => {
    const c = db.prepare('SELECT conv_id FROM episode GROUP BY conv_id ORDER BY COUNT(*) DESC LIMIT 1').get();
    const r = soulEpisode({ conv_id: c.conv_id, limit: 2 });
    return { conv: r.conv && r.conv.id, n: r.episodes.length };
  });
  time('gate_pass', () => soulPropose({ claim: 'I prefer Persian and hate polite filler', note: 'selftest' }).auto_verdict);
  time('gate_quar', () => soulPropose({ claim: 'the ritual is the protocol is the key is the truth' }).auto_verdict);
  time('gate_super', () => soulPropose({ claim: 'a spirit entity descends and possesses the operator' }).auto_verdict);
  time('gate_unknown', () => soulPropose({ claim: 'some unclassified statement' }).auto_verdict);
  time('admit_bad', () => soulAdmit({ claim: 'x' }).error);
  time('admit_ok', () => soulAdmit({ verdict: 'pass', claim: 'selftest admit', reason: 'selftest' }).decision);
  time('res_profile', () => { const r = readResource('soul://profile'); return { keys: Object.keys(r).sort(), l0: r.l0_pointers.map((x) => x.name).sort() }; });
  time('res_gate', () => readResource('soul://gate').log.rows);
  time('unknown_tool', () => { try { callTool('nope', {}); return 'threw'; } catch (e) { return 'threw: ok'; } });

  // ── pure-helper units for buildMatch (no DB round-trip) ────────────────
  // The ZWNJ/tatweel split is load-bearing: the corpus is mostly space
  // separated ("نرم افزار") while users type joined ("نرم‌افزار"). faNormalize
  // deletes the joiner, so without the split the joined spelling lost rows.
  const mk = (q) => { try { return buildMatch(q); } catch (e) { return 'THREW:' + e.message; } };
  out.unit = {
    zwnj: mk('نرم‌افزار'),
    tatweel: mk('نرمــافزار'),
    spaced: mk('نرم افزار'),
    plain: mk('software memory'),
    injection: mk('" OR NEAR(a b)'),
    capped: mk('a1 a2 a3 a4 a5 a6 a7 a8 a9 a10 a11 a12 a13 a14 a15 a16'),
    empty: mk(''),
    blank: mk('   '),
    joiner_only: mk('‌'),
  };
  // Corpus coverage: joined spelling must reach >= what the spaced spelling
  // reaches. Measured 11 vs 32 before the fix.
  const countMatch = (q) => {
    try {
      const m = buildMatch(q);
      if (!m) return 0;
      return db.prepare('SELECT COUNT(*) c FROM message_fts WHERE message_fts MATCH ?').get(m).c;
    } catch (e) { return -1; }
  };
  out.coverage = { zwnj_rows: countMatch('نرم‌افزار'), spaced_rows: countMatch('نرم افزار') };

  // Roll the audit log back so selftest leaves no trace.
  const after = gateCounts();
  withWrite(() => G.deleteAfter.run(before.max_id));
  const restored = gateCounts();

  const ver = (k) => out[k] && out[k].result;
  out.assert = {
    ping: !!(ver('ping') && ver('ping').ok),
    ladder_counts: !!(ver('ladder') && ver('ladder').messages === 16908),
    recall_en: (ver('recall_en') || []).length > 0,
    recall_fa: (ver('recall_fa') || []).length > 0,
    recall_zwnj: (ver('recall_zwnj') || []).length > 0,
    unit_zwnj_split: out.unit.zwnj === '"نرمافزار" OR "نرم" OR "افزار"*',
    unit_tatweel_split: out.unit.tatweel === out.unit.zwnj,
    unit_spaced_unchanged: out.unit.spaced === '"نرم" OR "افزار"*',
    unit_plain: out.unit.plain === '"software" OR "memory"*',
    unit_injection: typeof out.unit.injection === 'string'
      && out.unit.injection.split(' OR ').every((t) => /^"[^"]*"\*?$/.test(t))
      && !/[()]/.test(out.unit.injection),
    unit_cap_12: (out.unit.capped.match(/ OR /g) || []).length === 11 && /\*$/.test(out.unit.capped),
    unit_empty_null: out.unit.empty === null && out.unit.blank === null && out.unit.joiner_only === null,
    zwnj_covers_spaced: out.coverage.zwnj_rows >= out.coverage.spaced_rows && out.coverage.zwnj_rows > 11,
    injection_safe: ver('recall_injection') === 'safe',
    role_filter: ver('recall_role_user') === true,
    persona: (ver('persona') || []).length > 0,
    atoms: (ver('atoms') || 0) > 0,
    ep_none_error: !!ver('ep_none') && !!ver('ep_none').note,
    ep_conv: !!(ver('ep_conv') && ver('ep_conv').n === 2),
    gate_pass: ver('gate_pass') === 'pass',
    gate_synthesis: ver('gate_quar') === 'quarantine',
    gate_supernatural: ver('gate_super') === 'quarantine',
    gate_unknown: ver('gate_unknown') === 'review',
    admit_requires_verdict: /verdict required/.test(ver('admit_bad') || ''),
    admit_ok: ver('admit_ok') === 'pass',
    resource_profile: (() => {
      const p = readResource('soul://profile');
      return Array.isArray(p.l0_pointers) && p.l0_pointers.length > 0
        && Array.isArray(p.traits) && p.traits.length > 0
        && p.l0_pointers.every((x) => typeof x.name === 'string' && typeof x.value === 'string' && x.value.length > 0);
    })(),
    // ── held-tier invariants (the gate blind spot) ──────────────────────
    held_tier_exhaustive: (() => { const t = ver('atoms_tiers') || {}; return t.tiers_sum === 41 && t.auth_count === 23 && t.held_count === 18; })(),
    held_never_merged: ver('atoms_tiers').never_merged === true && ver('atoms_tiers').all_held_separate === true,
    held_default_advertised: ver('atoms_tiers').default_advertises_held === true,
    held_warning_present: ver('atoms_tiers').held_has_warning === true && ver('res_atoms').warning === true,
    held_id_lookup_routes: ver('atoms_tiers').id_held_tier === true && ver('atoms_tiers').id_auth_tier === true,
    held_missing_id_distinct: ver('atoms_tiers').missing_id === 'atom not found',
    atoms_resource_both_tiers: ver('res_atoms').atoms === 23 && ver('res_atoms').held === 18,
    l0_pointers_present: ['derail_watch', 'crisis_context', 'inner_voice', 'protect_first']
      .every((n) => (ver('pointers_l0') || []).includes(n)),
    unknown_tool_throws: (ver('unknown_tool') || '').endsWith('ok'),
    gate_writes_happened: after.rows > before.rows,
    gate_rolled_back: restored.rows === before.rows,
  };
  out.ok = Object.values(out.assert).every(Boolean);
  out.gate_log = { before, after, restored };
  out.finished = new Date().toISOString();
  console.log(JSON.stringify(out, null, 2));
  try { db && db.close(); gate && gate.close(); } catch {}
  process.exit(out.ok ? 0 : 1);
}

if (process.argv.includes('--selftest')) selftest();
else if (process.argv.includes('--dump')) selftest();
else serve();
