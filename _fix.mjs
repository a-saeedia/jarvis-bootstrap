// strip non-ASCII from .ps1 files (PS 5.1 reads no-BOM UTF-8 as CP1252,
// where 0x94 becomes a smart quote and wrecks the parser)
import fs from 'node:fs';

const files = [
  'D:/projects/outsider/_push.ps1',
  'D:/projects/outsider/install.ps1',
  'D:/projects/outsider/_pp.ps1',
  'D:/projects/outsider/_sec.ps1',
];
const map = { '—': '-', '–': '-', '‘': "'", '’': "'", '“': '"', '”': '"', '…': '...', '✓': '[ok]', '✗': '[x]' };

for (const f of files) {
  let s;
  try { s = fs.readFileSync(f, 'utf8'); } catch { continue; }
  const before = s;
  s = s.replace(/[—–‘’“”…✓✗]/g, (c) => map[c] ?? '-');
  s = s.replace(/[^\x00-\x7F]/g, '?');
  if (s !== before) {
    fs.writeFileSync(f, s, 'utf8');
    console.log(`cleaned ${f.split('/').pop()}  non-ascii remaining: ${(s.match(/[^\x00-\x7F]/g) || []).length}`);
  } else {
    console.log(`ok      ${f.split('/').pop()}`);
  }
}
