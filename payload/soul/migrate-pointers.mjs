#!/usr/bin/env node
// migrate-pointers.mjs — idempotent pointer seed for the held-tier fix.
//
// WHY: 18 of 41 atoms are held by the distill admission gate. Asserting them
// about the user would bypass the gate, so they stay out of `atoms`. But the
// BEHAVIOR they imply is not a claim about the user — it is how to work with
// him. Hiding that produced a cheerful persona with no memory of its own
// recorded failures (e.g. atom 34: the assistant kept dragging the session back
// into dream/sigil interpretation and the user had to re-issue the same
// redirect). So the operational content is promoted to L0 pointers, which are
// read on every profile load.
//
// INVARIANTS:
//   - runs OFFLINE. The MCP server itself opens soul.db read-only
//     (PRAGMA query_only=ON); this is the sanctioned write path.
//   - idempotent: keyed on (tier, name). Re-running updates in place, never
//     duplicates, never touches L1-L3.
//   - pointer rows are pointers, not claims: no gate/verdict columns, and
//     nothing here is copied into AGENTS.md.
//
// Usage:  node migrate-pointers.mjs            # plan (read-only, the default)
//         node migrate-pointers.mjs --dry-run  # plan, labelled dry-run
//         node migrate-pointers.mjs --verify   # assert L0 state, read-only
//         node migrate-pointers.mjs --apply    # WRITE (idempotent)
//         node migrate-pointers.mjs --help
//        (not `--check`: node consumes that as its own syntax-check flag)
//
// SAFETY: a bare invocation is READ-ONLY. Writing requires the explicit
// --apply flag. An earlier revision defaulted to writing (`apply = !dryRun &&
// !verify`), so a plain run committed the inserts with no visible intent in the
// command line — the exact footgun the plan default now prevents. --dry-run and
// --verify additionally open the connection readOnly, so a read-only mode can
// never touch the WAL header or page cache.

import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(HERE, 'soul.db');

const argv = process.argv.slice(2);
const KNOWN = new Set(['--apply', '--dry-run', '--verify', '--help', '-h']);
const unknown = argv.filter((a) => a.startsWith('-') && !KNOWN.has(a));

const USAGE = `migrate-pointers.mjs — idempotent L0 pointer seed

  (no flags)   plan        read-only; prints the actions that would run
  --dry-run    dry-run     read-only; same as plan
  --verify     verify      read-only; asserts the L0 seed, exit 1 on drift
  --apply      apply       WRITES soul.db (idempotent)
  --help       this text
`;

if (unknown.length) {
  console.error(`unknown flag(s): ${unknown.join(' ')}\n\n${USAGE}`);
  process.exit(2);
}
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}

const dryRun = argv.includes('--dry-run');
const verify = argv.includes('--verify');
const apply = argv.includes('--apply');
if (apply && (dryRun || verify)) {
  console.error('--apply is mutually exclusive with --dry-run/--verify\n\n' + USAGE);
  process.exit(2);
}

// `apply` is the single gate on every mutation below. Nothing writes unless it
// is true, and the connection is opened readOnly whenever it is false.
const MODE = apply ? 'apply' : verify ? 'verify' : dryRun ? 'dry-run' : 'plan';

// tier, name, value, note
const L0_SEED = [
  ['L0', 'derail_watch',
    'On symbolic/occult/rune/sigil/talisman requests, stay on the concrete ask (a protocol, a build, a mapping). Do NOT redirect into dream-interpretation, sigil-meaning, or MagicOS framing — that is the recorded failure mode in the corpus.',
    'behavioral; derived from held atom 34 (not an assertion about the user)'],
  ['L0', 'crisis_context',
    'Additions, relapse, war, and people disappearing from his life are live context, not background color. Never pivot these to project work or treat them as a phase to pass through.',
    'behavioral; derived from held atoms (not an assertion about the user)'],
  ['L0', 'inner_voice',
    'Where the corpus records doubt about a method or a self-image, hold it as the user\'s own recorded voice. Do not confirm it, amplify it, or convert it into a persona trait.',
    'behavioral; derived from held atoms (not an assertion about the user)'],
  ['L0', 'protect_first',
    'Ritual/protocol work is protective for him and is done before sleep, not deferred to a morning session. Protect the slot; do not reschedule it.',
    'behavioral; derived from held atoms (not an assertion about the user)'],
  // Added 2026-09-27 from the A/B result: the corpus held both senses of
  // "sigil" as separate atoms but no record of the COLLISION, so the
  // disambiguation item scored 0/4 in every condition (see
  // vault/notes/2026-09-27-soul-ab-test-results.md, finding 4). Complements
  // derail_watch: that one stops over-interpretation, this one supplies the
  // two senses. Do not merge the two.
  ['L0', 'sigil_sense',
    '"sigil" collides in this user\'s vocabulary and means two different things: his brand logo (a design asset he made) and a magical sigil (ritual/occult object). Disambiguate by the context of the request and name which sense is meant. It is a vocabulary fact, not an invitation to interpret.',
    'behavioral; derived from authoritative atoms 12-16 + the AGENTS.md disambiguation rule (not an assertion about the user)'],
];

const COLS = 'tier, name, value, note';

function main() {
  // A read-only mode that still opens the file read-write can mutate it (WAL
  // header, page cache flush). Open read-only at the connection level instead.
  const db = new DatabaseSync(DB_PATH, apply ? {} : { readOnly: true });
  db.exec('PRAGMA busy_timeout=5000;');
  if (apply) db.exec('PRAGMA journal_mode=WAL;');

  const sel = db.prepare(`SELECT id, ${COLS} FROM pointer WHERE tier = ? AND name = ?`);
  const ins = db.prepare(`INSERT INTO pointer (${COLS}) VALUES (?,?,?,?)`);
  const upd = db.prepare(`UPDATE pointer SET value = ?, note = ? WHERE id = ?`);

  const before = db.prepare(`SELECT COUNT(*) c FROM pointer`).get().c;
  const actions = [];

  // No transaction when not applying: a read-only run must not touch the file.
  if (apply) db.exec('BEGIN');
  try {
    for (const [tier, name, value, note] of L0_SEED) {
      const found = sel.get(tier, name);
      const label = !found ? 'insert' : (found.value !== value || found.note !== note) ? 'update' : 'unchanged';
      if (apply && label === 'insert') ins.run(tier, name, value, note);
      if (apply && label === 'update') upd.run(value, note, found.id);
      actions.push({ action: apply ? (label === 'unchanged' ? 'unchanged' : label + 'd') : 'would-' + label, tier, name });
    }
    if (apply) db.exec('COMMIT');
  } catch (e) {
    if (apply) db.exec('ROLLBACK');
    db.close();
    throw e;
  }

  const after = apply ? db.prepare(`SELECT COUNT(*) c FROM pointer`).get().c : before;
  const l0 = db.prepare(`SELECT name, value, note FROM pointer WHERE tier = 'L0' ORDER BY name`).all();

  if (verify) {
    const want = new Map(L0_SEED.map(([t, n, v, no]) => [n, { v, no }]));
    const missing = [...want.keys()].filter((n) => !l0.some((r) => r.name === n));
    const drifted = l0.filter((r) => want.has(r.name) && (want.get(r.name).v !== r.value || want.get(r.name).no !== r.note));
    console.log(JSON.stringify({
      mode: 'verify', wrote: false, l0_count: l0.length, l0_names: l0.map((r) => r.name),
      missing, drifted: drifted.map((r) => r.name), ok: missing.length === 0 && drifted.length === 0,
    }, null, 2));
    db.close();
    process.exit(missing.length === 0 && drifted.length === 0 ? 0 : 1);
  }

  console.log(JSON.stringify({
    mode: MODE, wrote: apply, db: DB_PATH,
    pointer_rows_before: before, pointer_rows_after: after,
    actions, l0_names: l0.map((r) => r.name),
  }, null, 2));
  db.close();
}

main();
