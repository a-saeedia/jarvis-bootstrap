/**
 * soul/lib.mjs — single source of truth for the pure helpers shared by
 * ingest.mjs and server.mjs. No I/O, no side effects, import-safe.
 *
 * Keeping these here prevents gate/normalize drift between the corpus builder
 * and the MCP server: the server must never re-grade a claim differently than
 * the corpus was graded.
 */

export const ZWNJ = '\u200C';

/** Persian-safe normalization: query and body go through the SAME transform. */
export function faNormalize(s) {
  return String(s == null ? '' : s)
    .replace(/\u200C/g, '')                    // zero-width non-joiner
    .replace(/\u0640/g, '')                   // tatweel / kashida
    .replace(/\u0649/g, '\u06CC')             // ARABIC YEH  -> FARSI YEH
    .replace(/\u064A/g, '\u06CC')             // ALEF MAKSURA -> FARSI YEH
    .replace(/\u06AA/g, '\u0647')             // HEH GOAL -> HEH
    .replace(/\u0629/g, '\u0647')             // TEH MARBUTA -> HEH
    .toLowerCase();
}

const FA_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
export const isFa = (s) => FA_RE.test(String(s || ''));
export const hasEmoji = (s) => /\p{Extended_Pictographic}/u.test(String(s || ''));

/** Normalize a possibly-absent user number to a finite number or null. */
export function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function clampNum(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

/** Truncate on a clean boundary, never mid-surrogate. */
export function clip(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const lim = Number.isFinite(Number(n)) ? Math.max(0, Math.floor(Number(n))) : 0;
  if (!lim || t.length <= lim) return t;
  return t.slice(0, lim - 1) + '\u2026';
}

/** ts is unix SECONDS in this corpus; null-in / null-out. */
export const iso = (ts) => (ts == null ? null : new Date(Number(ts) * 1000).toISOString());
export const nowSec = () => Date.now() / 1000;

// ── admission gate (order is policy: facts/preferences pass, then
// synthesis/protocol, then supernatural mechanism, else human review) ──
const SYNTHESIS = /\b(the (universe|reality|code|matrix) (is|works)|reality (is|works)|meaning of life|the (answer|key) is|magic works|it works because|the process is|the method is|the ritual is|the protocol is|therefore|thus we|we must|the secret is|the truth is)\b/gi;
const SUPERNATURAL = /\b(spirit|entity|entities|possess|invocation|descend|manifest|ascend|ritual magic|occult|supernatural|paranormal|demon|angel|genie|energy|channel|awaken|activate|the gate|the sigil works|blessing|curse|protection)\b/gi;
const FACT_RE = /\b(my name is|i was born|my age|i live in|i work as|i have \d|i own|i use|i prefer|i like|i hate|i always|i never|i usually)\b/i;
const PREF_RE = /\b(prefer|favou?rite|always|never|usual)\b/i;
const SYNTH_TAG_RE = /\b(synthesis|protocol|method|recipe|steps to|framework)\b/i;

/**
 * Known limitation (recorded, not silently changed): the FACT patterns are
 * first-person ("my name is"). Third-person distill claims ("The user's name
 * is [OPERATOR]") therefore grade as `review`, not `pass` — see atoms in the DB,
 * where `gate` is the distill authority and `verdict` is this runtime re-check.
 */
export function gateClaim(claim) {
  const c = String(claim == null ? '' : claim);
  if (FACT_RE.test(c) || PREF_RE.test(c)) {
    return { verdict: 'pass', reason: 'fact/preference about user', kind: 'FACT' };
  }
  SYNTHESIS.lastIndex = 0;                       // stateful /g regex — reset first
  if (SYNTHESIS.test(c) || SYNTH_TAG_RE.test(c)) {
    return { verdict: 'quarantine', reason: 'synthesis/protocol — not a fact', kind: 'SYNTHESIS' };
  }
  SUPERNATURAL.lastIndex = 0;
  if (SUPERNATURAL.test(c)) {
    return { verdict: 'quarantine', reason: 'supernatural/magic mechanism claim', kind: 'SUPERNATURAL' };
  }
  return { verdict: 'review', reason: 'unclassified — human review', kind: 'UNKNOWN' };
}

const JOINER_RE = /[\u200C\u0640]/;               // ZWNJ | tatweel
const MAX_TERMS = 12;

/**
 * Pull quoted terms out of one already-normalized string into `out`.
 * Returns true when the cap is hit (caller stops).
 */
function collectTerms(s, out, seen) {
  const re = /[\p{L}\p{N}_]+/gu;
  let m;
  while ((m = re.exec(s)) !== null) {
    const t = m[0];
    if (out.length && t.length < 2) continue;   // 1-char noise after the first
    if (seen.has(t)) continue;                  // dedupe: split forms repeat
    seen.add(t);
    out.push('"' + t.replace(/"/g, '""') + '"');
    if (out.length >= MAX_TERMS) return true;
  }
  return false;
}

/**
 * FTS5 MATCH builder. User text must never become FTS syntax, so every term is
 * extracted, escaped and quoted. Last term gets a prefix star for partial typing.
 *
 * Persian compounds are typed with a ZWNJ/tatweel ("نرم‌افزار"), but the corpus
 * is indexed from text that is mostly space-separated ("نرم افزار"). faNormalize
 * DELETES the joiner, so the query collapses to the single token "نرمافزار*",
 * which matches almost nothing — measured 11 rows vs 32 for the spaced form.
 * So when the raw query carries a joiner we also emit the split components:
 *   نرم‌افزار -> "نرمافزار" OR "نرم" OR "افزار"*
 * The joined form stays first and the split components follow, so the prefix
 * star lands on the last component (the part the user is still typing).
 */
export function buildMatch(query) {
  const raw = String(query == null ? '' : query);
  const sources = [faNormalize(raw)];
  if (JOINER_RE.test(raw)) {
    for (const part of raw.split(/[\u200C\u0640]+/)) {
      const p = faNormalize(part);
      if (p) sources.push(p);
    }
  }
  const terms = [];
  const seen = new Set();
  for (const s of sources) {
    if (collectTerms(s, terms, seen)) break;
  }
  if (!terms.length) return null;
  const last = terms.pop();
  terms.push(last + '*');
  return terms.join(' OR ');
}
