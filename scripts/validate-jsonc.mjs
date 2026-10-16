// validate-jsonc.mjs — strip JSONC comments/trailing commas and assert the file parses.
// Usage: node validate-jsonc.mjs <file.jsonc>
import fs from 'node:fs';

const file = process.argv[2];
if (!file) { console.error('usage: node validate-jsonc.mjs <file.jsonc>'); process.exit(2); }

let src = fs.readFileSync(file, 'utf8');

// strip block comments, then line comments (string-aware naive scan)
let out = '';
let inStr = false, esc = false, i = 0;
while (i < src.length) {
  const c = src[i], n = src[i + 1];
  if (inStr) {
    out += c;
    if (esc) esc = false;
    else if (c === '\\') esc = true;
    else if (c === '"') inStr = false;
    i++;
    continue;
  }
  if (c === '"') { inStr = true; out += c; i++; continue; }
  if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
  if (c === '/' && n === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
  out += c;
  i++;
}
// drop trailing commas
out = out.replace(/,(\s*[}\]])/g, '$1');

let obj;
try {
  obj = JSON.parse(out);
} catch (e) {
  console.error(`✗ ${file} is not valid JSON/JSONC: ${e.message}`);
  process.exit(1);
}

const mcp = obj.mcp || {};
const agents = obj.agent || {};
const results = [
  ['parses as JSON', true],
  [`mcp servers: ${Object.keys(mcp).length}`, Object.keys(mcp).length > 0],
  [`agents: ${Object.keys(agents).length}`, Object.keys(agents).length > 0],
  ['default model set', typeof obj.model === 'string' && obj.model.length > 0],
  ['no unresolved placeholders', !/\{\{[A-Z]+\}\}/.test(out)],
  ['no raw BOM', !out.includes('\uFEFF')],
];

let bad = 0;
for (const [label, pass] of results) {
  console.log(`${pass ? '✓' : '✗'} ${label}`);
  if (!pass) bad++;
}

// surface enabled mcp servers
const enabled = Object.entries(mcp).filter(([, v]) => v && v.enabled !== false).map(([k]) => k);
console.log(`\nenabled MCP: ${enabled.join(', ')}`);
console.log(`disabled MCP: ${Object.keys(mcp).length - enabled.length}`);

// foreign-machine paths: a Windows path is only acceptable when THIS machine
// is Windows and it points at this user's home.
import os from 'node:os';
const isWin = process.platform === 'win32';
const user = os.userInfo().username.toLowerCase();
const found = [...out.matchAll(/C:[/\\]Users[/\\]([A-Za-z0-9_.-]+)/g)].map((m) => m[1]);
const foreign = found.filter((u) => !isWin || u.toLowerCase() !== user);
if (found.length === 0) {
  console.log('✓ no windows-only paths');
} else if (foreign.length === 0) {
  console.log(`✓ ${found.length} windows paths, all belong to this machine (${user})`);
} else {
  console.log(`! ${foreign.length} foreign-machine path(s): ${[...new Set(foreign)].join(', ')}`);
}

process.exit(bad ? 1 : 0);
