#!/usr/bin/env node
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { atomicJson, now, readJson, SezuError } from './util.mjs';

const metadataPath = process.argv[2];
if (!metadataPath) throw new Error('metadata path required');
const dir = path.dirname(metadataPath);
const stdoutPath = path.join(dir, 'stdout');
const stderrPath = path.join(dir, 'stderr');
const controlPath = path.join(dir, 'control.sock');
let metadata = await readJson(metadataPath);
let child = null;
let cancelled = false;
let interrupted = false;
let paused = false;
let timeout = null;

async function save(patch = {}) {
  metadata = { ...metadata, ...patch, updated_at: now() };
  await atomicJson(metadataPath, metadata);
}
async function signal(sig) {
  if (!child?.pid) throw new SezuError('job_not_running', 'job process is not running');
  process.kill(-child.pid, sig);
}
async function command(message) {
  switch (message.type) {
    case 'stdin': {
      if (!child?.stdin?.writable) throw new SezuError('stdin_closed', 'job stdin is closed');
      child.stdin.write(Buffer.from(String(message.data || ''), message.encoding || 'base64'));
      return { written: Buffer.from(String(message.data || ''), message.encoding || 'base64').length };
    }
    case 'stdin_end': child?.stdin?.end(); return { closed: true };
    case 'signal': await signal(message.signal || 'SIGTERM'); return { signal: message.signal || 'SIGTERM' };
    case 'pause': await signal('SIGSTOP'); paused = true; await save({ state: 'paused' }); return { state: 'paused' };
    case 'resume': await signal('SIGCONT'); paused = false; await save({ state: 'running' }); return { state: 'running' };
    case 'cancel': cancelled = true; await signal(message.signal || 'SIGTERM'); return { state: 'cancelling' };
    case 'status': return metadata;
    default: throw new SezuError('invalid_request', `unknown job control message: ${message.type}`);
  }
}

await fsp.rm(controlPath, { force: true });
const server = net.createServer({ allowHalfOpen: true }, socket => {
  let text = '';
  socket.setEncoding('utf8');
  socket.on('data', chunk => { text += chunk; });
  socket.on('end', async () => {
    try { socket.end(JSON.stringify({ ok: true, result: await command(JSON.parse(text)) }) + '\n'); }
    catch (e) { socket.end(JSON.stringify({ ok: false, error: { code: e.code || 'operation_failed', message: e.message } }) + '\n'); }
  });
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(controlPath, resolve); });
await fsp.chmod(controlPath, 0o660);

const out = fs.openSync(stdoutPath, 'a', 0o640);
const err = fs.openSync(stderrPath, 'a', 0o640);
const spec = metadata.command_spec;
child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd || '/', env: spec.env || process.env, stdio: ['pipe', out, err], detached: true });
child.once('error', async e => { await save({ state: 'failed', error: { code: 'spawn_failed', message: e.message }, completed_at: now() }); process.exitCode = 1; });
await save({ state: 'running', runner_pid: process.pid, pid: child.pid, started_at: metadata.started_at || now(), control_socket: controlPath });

if (metadata.timeout_ms > 0) {
  timeout = setTimeout(async () => {
    interrupted = true;
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000).unref();
  }, metadata.timeout_ms);
  timeout.unref();
}
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => { interrupted = true; try { process.kill(-child.pid, sig); } catch {} });

const terminal = await new Promise(resolve => child.once('close', (code, signalName) => resolve({ code, signalName })));
if (timeout) clearTimeout(timeout);
server.close(); await fsp.rm(controlPath, { force: true });
fs.closeSync(out); fs.closeSync(err);
let state = 'completed';
if (cancelled) state = 'cancelled';
else if (interrupted) state = 'interrupted';
else if (terminal.code !== 0 || terminal.signalName) state = 'failed';
await save({ state, exit_code: terminal.code, signal: terminal.signalName, completed_at: now(), paused: false });
