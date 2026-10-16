// build-template.mjs — turn a live, machine-specific opencode.jsonc into a
// portable template with placeholders.
//
//   node scripts/build-template.mjs \
//     --from ~/.config/opencode/opencode.jsonc \
//     --out  payload/config/opencode.jsonc.tmpl
//
// String substitution only, so JSONC comments survive verbatim.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const argv = process.argv.slice(2);
const getFlag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : dflt;
};

const SRC = path.resolve(
  getFlag('from', path.join(os.homedir(), '.config', 'opencode', 'opencode.jsonc'))
);
const OUT = path.resolve(getFlag('out', 'payload/config/opencode.jsonc.tmpl'));

if (!fs.existsSync(SRC)) {
  console.error(`build-template: source not found: ${SRC}`);
  process.exit(2);
}

let s = fs.readFileSync(SRC, 'utf8');

// 1. drop the UTF-8 BOM so it never lands mid-file
s = s.replace(/\uFEFF/g, '');

// 2. neutralise the username (machine-specific)
s = s.replace(/"username":\s*"[^"]*"/, '"username": "{{USERNAME}}"');

// 3. path placeholders — order matters (most specific first)
const HOME_ESC = os.homedir().replace(/\\/g, '\\\\');
const rules = [
  // node binary, both slash styles
  [new RegExp(`${os.homedir().replace(/\\/g, '/')}/tools/node/node\\.exe`, 'g'), '{{NODE}}'],
  [new RegExp(`${HOME_ESC}\\\\tools\\\\node\\\\node\\.exe`, 'g'), '{{NODE}}'],
  // config dir
  [new RegExp(`${os.homedir().replace(/\\/g, '/')}/\\.config/opencode`, 'g'), '{{CONFIG}}'],
  [new RegExp(`${HOME_ESC}\\\\\.config\\\\opencode`, 'g'), '{{CONFIG}}'],
  // windows binary suffix
  [/github-mcp-server\.exe/g, 'github-mcp-server'],
  // home, both slash styles (catch-all last)
  [new RegExp(os.homedir().replace(/\\/g, '/'), 'g'), '{{HOME}}'],
  [new RegExp(HOME_ESC, 'g'), '{{HOME}}'],
];

for (const [re, to] of rules) s = s.replace(re, to);

// 4. hard-fail if a real credential leaked into the template
const leakPatterns = [
  /ghp_[A-Za-z0-9]{20,}/, /github_pat_[A-Za-z0-9_]{20,}/,
  /sk-[A-Za-z0-9]{20,}/, /sk-ant-[A-Za-z0-9\-_]{20,}/,
  /AKIA[0-9A-Z]{16}/, /AIza[0-9A-Za-z\-_]{30,}/,
];
const leaks = leakPatterns.flatMap((re) => (s.match(re) || []));
if (leaks.length) {
  console.error(`build-template: ABORT — ${leaks.length} credential-like string(s) in the source:`);
  for (const l of leaks) console.error(`  ${l.slice(0, 12)}…`);
  process.exit(1);
}

// 5. make sure no absolute home path survived
const leftovers = (s.match(/C:\/Users\/|C:\\\\Users/g) || []).length;

const header = `// opencode.jsonc — rendered from a portable template at install time.
// Placeholders ({{NODE}}, {{CONFIG}}, {{HOME}}, {{USERNAME}}) are resolved for
// your machine. Secrets are NEVER stored here: every credential is an
// {env:NAME} reference resolved from the environment.
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, header + s, 'utf8');

console.log(`in   ${SRC}`);
console.log(`out  ${OUT}`);
console.log(`size ${Buffer.byteLength(s)} bytes`);
console.log(
  `placeholders  NODE=${(s.match(/\{\{NODE\}\}/g) || []).length} ` +
  `CONFIG=${(s.match(/\{\{CONFIG\}\}/g) || []).length} ` +
  `HOME=${(s.match(/\{\{HOME\}\}/g) || []).length}`
);
console.log(leftovers === 0 ? 'ok   no absolute home paths left' : `!!   ${leftovers} absolute home paths left`);
console.log('ok   no credential patterns found');
process.exit(leftovers === 0 ? 0 : 1);
