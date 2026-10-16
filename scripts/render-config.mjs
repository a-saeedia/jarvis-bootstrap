// render-config.mjs — resolve the portable opencode.jsonc template for this machine.
//
// Usage: node render-config.mjs <templatePath> <outPath> [configDir] [home] [node] [username]
// Does plain string substitution so JSONC comments are preserved verbatim.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [tpl, out, cfgArg, homeArg, nodeArg, userArg] = process.argv.slice(2);

if (!tpl || !out) {
  console.error('usage: node render-config.mjs <template> <out> [configDir] [home] [node] [username]');
  process.exit(2);
}

const home = homeArg || os.homedir();
const configDir = cfgArg || path.join(home, '.config', 'opencode');
const nodeBin = nodeArg || process.execPath;
const username = userArg || os.userInfo().username || 'operator';

const toPosix = (p) => p.split(path.sep).join('/');

let s = fs.readFileSync(tpl, 'utf8');
// tolerate a BOM anywhere at the head of the template
if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
s = s.replace(/\uFEFF/g, '');

const subs = {
  '{{NODE}}': toPosix(nodeBin),
  '{{CONFIG}}': toPosix(configDir),
  '{{HOME}}': toPosix(home),
  '{{USERNAME}}': username,
};

for (const [k, v] of Object.entries(subs)) {
  s = s.split(k).join(v);
}

const left = Object.keys(subs).filter((k) => s.includes(k));
if (left.length) {
  console.error(`render-config: unresolved placeholders: ${left.join(', ')}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, s, 'utf8');

console.log(`rendered  ${path.relative(process.cwd(), out)}`);
console.log(`  configDir ${configDir}`);
console.log(`  home      ${home}`);
console.log(`  node      ${toPosix(nodeBin)}`);
console.log(`  username  ${username}`);
