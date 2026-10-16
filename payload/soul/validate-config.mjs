#!/usr/bin/env node
/**
 * validate-config.mjs — string-aware JSONC validation for opencode.jsonc.
 *
 * A regex strip of // comments corrupts URLs ("https://...") and escaped
 * quotes, so we walk the file with a tiny state machine that only treats
 * // and /* as comments when they are outside a string literal.
 */
import { readFileSync, existsSync } from 'node:fs';

const P = process.argv[2] || 'C:/Users/user/.config/opencode/opencode.jsonc';
const src = readFileSync(P, 'utf8').replace(/^\uFEFF/, '');   // file has a pre-existing BOM

function stripJsonc(s) {
  let out = '';
  let i = 0;
  let inStr = false, q = '';
  while (i < s.length) {
    const c = s[i], d = s[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') { out += d ?? ''; i += 2; continue; }
      if (c === q) inStr = false;
      i++; continue;
    }
    if (c === '"' || c === "'") { inStr = true; q = c; out += c; i++; continue; }
    if (c === '/' && d === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i += 2; continue; }
    out += c; i++;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');   // tolerate trailing commas
}

let j, err = null;
try { j = JSON.parse(stripJsonc(src)); } catch (e) { err = e.message; }

const A = {};
A.parse_ok = !err;
A.parse_error = err;
if (j) {
  A.top_level_soul_star = j.tools?.['soul*'] ?? '(absent)';
  A.alchemist_soul_star = j.agent?.alchemist?.tools?.['soul*'] ?? '(absent)';
  A.soul_mcp_enabled = j.mcp?.soul?.enabled ?? '(absent)';
  A.soul_mcp_type = j.mcp?.soul?.type ?? '(absent)';
  A.soul_mcp_cmd = (j.mcp?.soul?.command || []).join(' ');
  A.soul_mcp_cmd_exists = existsSync(j.mcp?.soul?.command?.[1] || 'nope');
  A.alchemist_preserved = {
    mode: j.agent?.alchemist?.mode,
    color: j.agent?.alchemist?.color,
    temperature: j.agent?.alchemist?.temperature,
    desc_len: (j.agent?.alchemist?.description || '').length,
    prompt_len: (j.agent?.alchemist?.prompt || '').length,
  };
  A.power_preserved = j.agent?.power?.model ?? '(absent)';
  A.build_preserved = j.agent?.build?.model ?? j.agent?.build ?? '(absent)';
  A.commands = Object.keys(j.command || {});
  A.mcp_count = Object.keys(j.mcp || {}).length;
  A.mcp_keys = Object.keys(j.mcp || {});
  A.server_preserved = j.server;
  A.small_model_preserved = j.small_model;
  A.instructions_preserved = j.instructions;
  A.gemini_model_preserved = j.provider?.google?.models ? Object.keys(j.provider.google.models).length : '(n/a)';
  A.https_intact = stripJsonc(src).includes('"https://');
}
A.ok = A.parse_ok
  && A.top_level_soul_star === false
  && A.alchemist_soul_star === true
  && A.soul_mcp_enabled === true
  && A.soul_mcp_type === 'local'
  && A.soul_mcp_cmd_exists === true
  && A.https_intact === true
  && A.commands.includes('magic') && A.commands.includes('power');

console.log(JSON.stringify({ file: P, A }, null, 2));
process.exit(A.ok ? 0 : 1);
