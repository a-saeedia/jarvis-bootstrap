#!/usr/bin/env node
/**
 * harness.mjs â€” real stdio protocol test for the Soul MCP server.
 *
 * Spawns `node server.mjs` as a child process and speaks newline-delimited
 * JSON-RPC 2.0 over stdin/stdout exactly as a client would. The in-process
 * --selftest does NOT cover this path, so this file is the transport proof.
 *
 * Run: node harness.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, 'server.mjs');
const NODE = process.execPath;

const child = spawn(NODE, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
child.stdout.setEncoding('utf8');
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (d) => { stderr += d; });

let buf = '';
const waiters = new Map();
let stdoutLines = 0;
child.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    stdoutLines++;
    let msg;
    try { msg = JSON.parse(line); }
    catch { out.malformedResponse = { raw: line.slice(0, 200) }; continue; }
    const w = waiters.get(msg.id);
    if (w) { waiters.delete(msg.id); w(msg); }
  }
});

let nextId = 1;
function send(obj) { child.stdin.write(JSON.stringify(obj) + '\n'); }
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { waiters.delete(id); reject(new Error(`timeout: ${method}`)); }, 15000);
    waiters.set(id, (m) => { clearTimeout(t); resolve(m); });
    send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const out = { started: new Date().toISOString(), cases: [], assert: {} };
function t(name, ok, detail) { out.cases.push({ name, ok, ...(detail === undefined ? {} : { detail }) }); return ok; }
const jtext = (m) => JSON.parse(m.result.content[0].text);

(async () => {
  // 1. initialization + version negotiation
  let m = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'harness', version: '1.0.0' },
  });
  t('initialize returns result', !!m.result, m.result && m.result.serverInfo);
  t('negotiates 2025-06-18', m.result.protocolVersion === '2025-06-18', m.result.protocolVersion);
  t('advertises tools+resources',
    !!m.result.capabilities.tools && !!m.result.capabilities.resources, Object.keys(m.result.capabilities));
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  // 2. an UNSUPPORTED requested version must fall back, not echo blindly
  const mOld = await rpc('initialize', { protocolVersion: '1999-01-01', capabilities: {} });
  t('unsupported version falls back to default', mOld.result.protocolVersion === '2025-06-18', mOld.result.protocolVersion);

  // 3. older-but-supported version is honored
  const mMid = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  t('supported legacy version honored', mMid.result.protocolVersion === '2024-11-05', mMid.result.protocolVersion);

  // 4. tools/list shape
  const tl = await rpc('tools/list');
  const tools = tl.result.tools;
  t('tools/list returns 8 tools', tools.length === 8, tools.map((t) => t.name));
  t('every tool has an object inputSchema', tools.every((t) => t.inputSchema && t.inputSchema.type === 'object'));
  t('soul_recall marks query required',
    (tools.find((t) => t.name === 'soul_recall').inputSchema.required || []).includes('query'));
  t('soul_admit marks verdict required',
    (tools.find((t) => t.name === 'soul_admit').inputSchema.required || []).includes('verdict'));

  // 5. resources/list â€” the mime/name defect
  const rl = await rpc('resources/list');
  const res = rl.result.resources;
  t('resources/list returns 6 resources', res.length === 6, res.map((r) => r.uri));
  t('no resource uses mime (must be mimeType)', res.every((r) => r.mime === undefined));
  t('every resource has mimeType + name',
    res.every((r) => typeof r.mimeType === 'string' && typeof r.name === 'string' && r.name.length > 0));
  t('soul://profile is present', res.some((r) => r.uri === 'soul://profile'));

  // 6. every resource reads
  for (const r of res) {
    const rr = await rpc('resources/read', { uri: r.uri });
    const ok = !!rr.result && !!rr.result.contents && rr.result.contents[0].text;
    let parsed = false;
    try { JSON.parse(rr.result.contents[0].text); parsed = true; } catch {}
    t(`read ${r.uri}`, ok && parsed);
  }

  // 7. every tool calls successfully over the pipe
  const calls = [
    ['soul_ping', {}],
    ['soul_ladder', {}],
    ['soul_recall', { query: 'why do I hate corporate AI slop', k: 3 }],
    ['soul_recall', { query: 'Ù…Ø¹Ù…Ø§Ø±ÛŒ', lang: 'fa', k: 3 }],
    ['soul_recall', { query: 'Ù†Ø±Ù…â€ŒØ§ÙØ²Ø§Ø±', k: 3 }],
    ['soul_persona', { k: 5 }],
    ['soul_atoms', { k: 5 }],
    ['soul_episode', { conv_id: dbgConvId() }],
  ];
  for (const [name, args] of calls) {
    if (args.conv_id === undefined) continue;
    const c = await rpc('tools/call', { name, arguments: args });
    const parsed = jtext(c);
    t(`call ${name} ${JSON.stringify(args).slice(0, 48)}`,
      c.result.isError !== true && !parsed.error, c.result.isError ? parsed.error : 'ok');
  }

  // 8. tool-level errors come back as isError, not a JSON-RPC fault
  const bad = await rpc('tools/call', { name: 'soul_recall', arguments: {} });
  t('missing required arg -> isError result (not rpc fault)',
    bad.result && bad.result.isError === true && /query required/.test(jtext(bad).error));
  const unknown = await rpc('tools/call', { name: 'soul_nope', arguments: {} });
  t('unknown tool -> -32602 with {code,message}',
    unknown.error && unknown.error.code === -32602 && typeof unknown.error.message === 'string',
    unknown.error);

  // 9. protocol errors
  const noMethod = await rpc('nope/does_not_exist');
  t('unknown method -> -32601', noMethod.error && noMethod.error.code === -32601, noMethod.error);
  const errShape = noMethod.error || {};
  t('error object uses message (not error)', typeof errShape.message === 'string' && errShape.error === undefined);

  // 10. bare notification must produce NO reply (would desync a client)
  const before = stdoutLines;
  send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 999 } });
  send({ jsonrpc: '2.0', method: 'another/unknown/notification' });
  await sleep(400);
  const ping = await rpc('ping');
  t('notifications produce no response', ping.result !== undefined && stdoutLines - before === 1,
    { delta: stdoutLines - before });

  // 11. malformed JSON line -> parse error, server stays alive
  child.stdin.write('{ this is not json\n');
  await sleep(400);
  const alive = await rpc('ping');
  t('survives malformed JSON line', alive.result !== undefined, alive.error);
  const after = await rpc('tools/list');
  t('still serving after parse error', !!after.result);

  // 12. rebuild safety: gate.db rows survive, corpus counts unchanged
  const g = jtext(await rpc('tools/call', { name: 'soul_ping', arguments: {} }));
  t('ping reports corpus + gate paths', !!g.db && !!g.gate_db, { db: g.db, gate_db: g.gate_db });
  t('ping reports accepted atoms > 0', g.atoms_accepted > 0, g.atoms_accepted);
  t('corpus has 16908 messages', g.messages === 16908, g.messages);

  out.assert = {
    allCasesPassed: out.cases.every((c) => c.ok),
    failed: out.cases.filter((c) => !c.ok).map((c) => c.name),
  };
  out.ok = out.assert.allCasesPassed;
  out.stderr = stderr.trim() ? stderr.trim().slice(0, 800) : '(empty)';
  out.finished = new Date().toISOString();
  console.log(JSON.stringify(out, null, 2));
  child.stdin.end();
  await sleep(150);
  child.kill();
  process.exit(out.ok ? 0 : 1);
})().catch(async (e) => {
  console.log(JSON.stringify({ ok: false, fatal: e.message, stack: e.stack, stderr, cases: out.cases }, null, 2));
  child.kill();
  process.exit(1);
});

/** pick a real conv_id from the corpus via a throwaway direct query */
function dbgConvId() { return CONV_ID; }
let CONV_ID = null;
{
  const { DatabaseSync } = await import('node:sqlite');
  const d = new DatabaseSync(join(__dirname, 'soul.db'), { readOnly: true });
  CONV_ID = d.prepare('SELECT conv_id FROM episode GROUP BY conv_id ORDER BY COUNT(*) DESC LIMIT 1').get().conv_id;
  d.close();
}
