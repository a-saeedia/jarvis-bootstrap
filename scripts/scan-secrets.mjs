// scan-secrets.mjs — hard gate before every commit/push.
// Exit 1 if anything credential-shaped exists in tracked files.
//
//   node scripts/scan-secrets.mjs [root] [--file <path>]
//
// `--file` scans one raw blob (used by the pre-commit gate on staged diffs).
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const fileMode = args.includes('--file');
const fileArgIdx = args.indexOf('--file');
const TARGET = fileMode ? args[fileArgIdx + 1] : (args[0] || '.');

const PATTERNS = [
  [/\bghp_[A-Za-z0-9]{20,}/g, 'github personal access token'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, 'github fine-grained token'],
  [/\bgho_[A-Za-z0-9]{20,}/g, 'github oauth token'],
  [/\bghs_[A-Za-z0-9]{20,}/g, 'github app token'],
  [/\bghu_[A-Za-z0-9]{20,}/g, 'github user token'],
  [/\bsk-ant-[A-Za-z0-9\-_]{20,}/g, 'anthropic key'],
  [/\bsk-proj-[A-Za-z0-9\-_]{20,}/g, 'openai project key'],
  [/\bsk-[A-Za-z0-9]{32,}/g, 'openai-style key'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'aws access key id'],
  [/\bAIza[0-9A-Za-z\-_]{30,}/g, 'google api key'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, 'slack token'],
  [/\bglpat-[A-Za-z0-9_\-]{20,}/g, 'gitlab token'],
  [/\bBearer\s+[A-Za-z0-9._\-]{40,}/g, 'bearer token'],
  [/\bhf_[A-Za-z0-9]{20,}/g, 'huggingface token'],
  [/\bsk-or-v1-[A-Za-z0-9]{20,}/g, 'openrouter key'],
  [/\bnvapi-[A-Za-z0-9\-_]{20,}/g, 'nvidia api key'],
  [/\bsk-[a-z]{2,5}-[A-Za-z0-9]{20,}/g, 'prefixed service key'],
  [/-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g, 'private key block'],
];

// documentation false-positives: regex sources, examples, env refs
const ALLOW = /example|placeholder|your[_-]?key|xxx+|process\.env|env:\{|\{\{|scan-secrets|PATTERNS|pattern|SELECT-String|-Pattern|<.*>|\.\.\.|\$\{|YOUR_/i;

const SKIP = new Set(['.git', 'node_modules', '_test', '.tmp', 'tmp']);
const SKIP_EXT = new Set(['.db', '.png', '.jpg', '.jpeg', '.gif', '.zip', '.gz', '.woff', '.woff2', '.exe', '.bin']);

function scanText(body, f) {
  let hits = 0;
  for (const [re, label] of PATTERNS) {
    for (const m of body.matchAll(re)) {
      const ctx = body.slice(Math.max(0, m.index - 80), m.index + 80);
      if (ALLOW.test(ctx)) continue;
      hits++;
      const line = body.slice(0, m.index).split('\n').length;
      console.log(`HIT  ${label}\n     ${f}:${line}\n     ${m[0].slice(0, 16)}...`);
    }
  }
  return hits;
}

if (fileMode) {
  const body = fs.readFileSync(TARGET, 'utf8');
  const h = scanText(body, TARGET);
  console.log(h === 0 ? 'clean - no credential-shaped strings' : `${h} HIT(S) - DO NOT COMMIT`);
  process.exit(h ? 1 : 0);
}

const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name.startsWith('.') && e.name !== '.env.example') continue;
    if (SKIP.has(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (!SKIP_EXT.has(path.extname(e.name).toLowerCase())) files.push(p);
  }
})(TARGET);

let hits = 0;
for (const f of files) {
  let body;
  try { body = fs.readFileSync(f, 'utf8'); } catch { continue; }
  if (body.includes('\u0000')) continue; // binary
  hits += scanText(body, f);
}

console.log(`\nscanned ${files.length} files in ${TARGET}`);
console.log(hits === 0 ? 'clean - no credential-shaped strings' : `${hits} HIT(S) - DO NOT COMMIT`);
process.exit(hits ? 1 : 0);
