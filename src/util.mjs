import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

export const PRODUCT = 'sezu';
export const VERSION = '0.1.0';
export const PROTOCOL = 'SEZU1/1.0.0';
export const PROJECT = 'sezu';
export const SOCKET_PATH = '/run/sezu/supervisor.sock';
export const INCUS_SOCKET = '/var/lib/incus/unix.socket';
export const INLINE_LIMIT = 64 * 1024;
export const MAX_FRAME = 16 * 1024 * 1024;
export const ROOTS = Object.freeze({
  state: '/var/lib/sezu', jobs: '/var/lib/sezu/jobs', terminals: '/var/lib/sezu/terminals',
  artifacts: '/var/lib/sezu/artifacts', workspaces: '/var/lib/sezu/workspaces',
  browser: '/var/lib/sezu/browser-profiles', packs: '/var/lib/sezu/packs',
  templates: '/var/lib/sezu/templates', timers: '/var/lib/sezu/timers', storage: '/var/lib/sezu/storage',
  skillsBuiltin: '/opt/sezu/skills', skillsOwner: '/etc/sezu/skills', macros: '/etc/sezu/macros',
  release: '/opt/sezu/current', config: '/etc/sezu', cache: '/var/cache/sezu/sources'
});

export class SezuError extends Error {
  constructor(code, message, details = null, status = 'failed') {
    super(message); this.name = 'SezuError'; this.code = code; this.details = details; this.status = status;
  }
}

export function uuid() { return crypto.randomUUID(); }
export function now() { return new Date().toISOString(); }
export function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
export function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  }
  return value;
}
export function stableStringify(value) { return JSON.stringify(stable(value)); }
export function asObject(value, name = 'args') {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new SezuError('invalid_request', `${name} must be an object`);
  return value;
}
export function required(args, key, type = null) {
  if (!(key in args)) throw new SezuError('invalid_request', `missing required argument: ${key}`);
  if (type && typeof args[key] !== type) throw new SezuError('invalid_request', `${key} must be ${type}`);
  return args[key];
}
export function asString(value, name) {
  if (typeof value !== 'string' || !value.length) throw new SezuError('invalid_request', `${name} must be a nonempty string`);
  return value;
}
export function asArray(value, name) {
  if (!Array.isArray(value)) throw new SezuError('invalid_request', `${name} must be an array`);
  return value;
}
export function boundedInt(value, name, fallback = 0, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new SezuError('invalid_request', `${name} must be an integer from 0 through ${max}`);
  return value;
}
export function safeName(value, name = 'name') {
  asString(value, name);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new SezuError('invalid_request', `${name} contains invalid characters`);
  return value;
}
export function decodeData(args, key = 'data') {
  const value = required(args, key, 'string');
  const encoding = args.encoding ?? 'utf8';
  if (!['utf8', 'base64', 'hex'].includes(encoding)) throw new SezuError('invalid_request', `unsupported encoding: ${encoding}`);
  return Buffer.from(value, encoding);
}
export function encodeData(buffer, encoding = 'base64') {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer ?? '');
  if (encoding === 'utf8') return buffer.toString('utf8');
  if (encoding === 'hex') return buffer.toString('hex');
  return buffer.toString('base64');
}

export async function ensureDir(dir, mode = 0o750) { await fsp.mkdir(dir, { recursive: true, mode }); }
export async function exists(p) { try { await fsp.lstat(p); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
export async function readJson(file, fallback = undefined) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT' && fallback !== undefined) return fallback; throw e; }
}
export async function atomicWrite(file, data, mode = 0o640) {
  await ensureDir(path.dirname(file));
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${uuid()}.tmp`);
  const handle = await fsp.open(temp, 'wx', mode);
  try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
  await fsp.rename(temp, file);
}
export async function atomicJson(file, value, mode = 0o640) { await atomicWrite(file, JSON.stringify(value, null, 2) + '\n', mode); }
export async function listJson(dir) {
  await ensureDir(dir);
  const out = [];
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try { out.push(await readJson(path.join(dir, entry.name))); } catch { /* malformed entries are reported by get */ }
  }
  return out;
}

export function targetInstance(target) {
  if (target === 'u') return 'u';
  if (typeof target === 'string' && target.startsWith('cell:')) return safeName(target.slice(5), 'cell name');
  if (target === 'host') return null;
  throw new SezuError('invalid_target', `invalid target: ${target}`);
}

export function commandSpec(target, args = {}) {
  const a = asObject(args);
  const hasArgv = Array.isArray(a.argv) && a.argv.length > 0;
  const hasCommand = typeof a.command === 'string';
  if (hasArgv === hasCommand) throw new SezuError('invalid_request', 'provide exactly one of argv or command');
  let cmd = hasArgv ? a.argv.map(String) : [a.shell || '/bin/bash', '-lc', a.command];
  if (a.nice !== undefined) cmd = ['nice', '-n', String(a.nice), ...cmd];
  if (a.cpu_affinity !== undefined) cmd = ['taskset', '-c', Array.isArray(a.cpu_affinity) ? a.cpu_affinity.join(',') : String(a.cpu_affinity), ...cmd];
  if (a.cgroup && typeof a.cgroup === 'object') {
    const props = Object.entries(a.cgroup).flatMap(([k, v]) => ['--property', `${k}=${v}`]);
    cmd = ['systemd-run', '--quiet', '--wait', '--pipe', '--collect', ...props, '--', ...cmd];
  }
  const envAdd = asObject(a.env || a.environment || {}, 'environment');
  const envRemove = Array.isArray(a.env_remove) ? a.env_remove.map(String) : [];
  const instance = targetInstance(target);
  if (!instance) {
    const env = { ...process.env, ...Object.fromEntries(Object.entries(envAdd).map(([k, v]) => [k, String(v)])) };
    for (const key of envRemove) delete env[key];
    return { argv: cmd, cwd: a.cwd || '/', env };
  }
  const incus = ['incus', 'exec', instance, '--project', a.project || PROJECT];
  if (a.cwd) incus.push('--cwd', String(a.cwd));
  for (const [k, v] of Object.entries(envAdd)) incus.push('--env', `${k}=${v}`);
  let remote = cmd;
  if (envRemove.length) remote = ['env', ...envRemove.flatMap(k => ['-u', k]), ...remote];
  incus.push('--', ...remote);
  return { argv: incus, cwd: '/', env: process.env };
}

export async function runProcess(argv, options = {}) {
  if (!Array.isArray(argv) || !argv.length) throw new SezuError('invalid_request', 'argv must be nonempty');
  const tempDir = await fsp.mkdtemp(path.join(options.tempRoot || os.tmpdir(), 'sezu-run-'));
  const stdoutPath = path.join(tempDir, 'stdout');
  const stderrPath = path.join(tempDir, 'stderr');
  const out = await fsp.open(stdoutPath, 'w', 0o600);
  const err = await fsp.open(stderrPath, 'w', 0o600);
  let child;
  try {
    child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd || '/', env: options.env || process.env,
      stdio: ['pipe', out.fd, err.fd], detached: true
    });
  } catch (e) {
    await out.close(); await err.close(); await fsp.rm(tempDir, { recursive: true, force: true }); throw e;
  }
  if (options.stdin !== undefined && options.stdin !== null) child.stdin.end(Buffer.isBuffer(options.stdin) ? options.stdin : Buffer.from(options.stdin));
  else child.stdin.end();
  let timedOut = false;
  let timer = null;
  if (options.timeout_ms !== undefined && options.timeout_ms !== null) {
    const ms = boundedInt(options.timeout_ms, 'timeout_ms', 0, 7 * 24 * 60 * 60 * 1000);
    if (ms > 0) timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGTERM'); } catch {} setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000).unref(); }, ms).unref();
  }
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  }).finally(() => { if (timer) clearTimeout(timer); });
  await out.close(); await err.close();
  const stdoutSize = (await fsp.stat(stdoutPath)).size;
  const stderrSize = (await fsp.stat(stderrPath)).size;
  return { ...result, timedOut, tempDir, stdoutPath, stderrPath, stdoutSize, stderrSize, pid: child.pid };
}

export async function readRange(file, offset = 0, limit = INLINE_LIMIT) {
  offset = boundedInt(offset, 'offset', 0);
  limit = boundedInt(limit, 'limit', INLINE_LIMIT, 4 * 1024 * 1024);
  const stat = await fsp.stat(file);
  const size = Math.max(0, Math.min(limit, stat.size - offset));
  const buffer = Buffer.alloc(size);
  if (size) {
    const h = await fsp.open(file, 'r');
    try { await h.read(buffer, 0, size, offset); } finally { await h.close(); }
  }
  return { buffer, offset, next_offset: offset + size, size: stat.size, eof: offset + size >= stat.size };
}

export async function digestFile(file) {
  return await new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(file);
    input.on('error', reject); input.on('data', chunk => hash.update(chunk)); input.on('end', () => resolve(hash.digest('hex')));
  });
}

export async function artifactFromFile(file, metadata = {}) {
  await ensureDir(path.join(ROOTS.artifacts, 'sha256'));
  await ensureDir(path.join(ROOTS.artifacts, 'metadata'));
  const digest = await digestFile(file);
  const stat = await fsp.stat(file);
  const dest = path.join(ROOTS.artifacts, 'sha256', digest);
  if (!(await exists(dest))) await fsp.copyFile(file, dest, fs.constants.COPYFILE_EXCL).catch(e => { if (e.code !== 'EEXIST') throw e; });
  const record = { artifact_id: `sha256:${digest}`, digest, algorithm: 'sha256', size: stat.size, created_at: now(), ...metadata };
  await atomicJson(path.join(ROOTS.artifacts, 'metadata', `${digest}.json`), record);
  return record;
}

export function artifactPath(id) {
  const digest = String(id).replace(/^sha256:/, '');
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new SezuError('invalid_artifact', 'artifact id must be sha256:<64 hex>');
  return { digest, file: path.join(ROOTS.artifacts, 'sha256', digest), metadata: path.join(ROOTS.artifacts, 'metadata', `${digest}.json`) };
}

export async function inlineFile(file, encoding = 'utf8', limit = INLINE_LIMIT) {
  const stat = await fsp.stat(file);
  const read = await readRange(file, 0, Math.min(limit, INLINE_LIMIT));
  return { text: encodeData(read.buffer, encoding), bytes: stat.size, truncated: stat.size > read.buffer.length };
}

export function baseEnvelope(request, target) {
  return {
    ok: true, protocol: PROTOCOL, request_id: request.request_id || uuid(), operation: request.operation,
    target, status: 'completed', handle: null, exit_code: null, signal: null,
    stdout: '', stderr: '', truncated: false, artifacts: [], error: null, result: null
  };
}

export function failureEnvelope(request, target, error) {
  const e = error instanceof SezuError ? error : new SezuError('operation_failed', error?.message || String(error), error?.stack ? { stack: error.stack } : null);
  return {
    ...baseEnvelope(request, target), ok: false, status: e.status || 'failed',
    error: { code: e.code, message: e.message, details: e.details ?? null }
  };
}

export function normalizeIncusJsonBody(method, requestPath, body) {
  if (String(method).toUpperCase() === 'POST' && requestPath === '/1.0/images' && body && !Buffer.isBuffer(body) && typeof body === 'object' && !Array.isArray(body) && body.expires_at === undefined) {
    return { ...body, expires_at: new Date(0).toISOString() };
  }
  return body;
}

export async function incusRequest(method, requestPath, options = {}) {
  if (typeof requestPath !== 'string' || !requestPath.startsWith('/1.0')) throw new SezuError('invalid_request', 'Incus path must begin with /1.0');
  let p = requestPath;
  const query = new URLSearchParams(options.query || {});
  if (options.project && !query.has('project')) query.set('project', options.project);
  if ([...query].length) p += (p.includes('?') ? '&' : '?') + query.toString();
  let body = null;
  const headers = { Accept: 'application/json', ...(options.headers || {}) };
  const requestBody = normalizeIncusJsonBody(method, requestPath, options.body);
  if (requestBody !== undefined && requestBody !== null) {
    body = Buffer.isBuffer(requestBody) ? requestBody : Buffer.from(JSON.stringify(requestBody));
    if (!headers['Content-Type']) headers['Content-Type'] = Buffer.isBuffer(requestBody) ? 'application/octet-stream' : 'application/json';
    headers['Content-Length'] = String(body.length);
  }
  return await new Promise((resolve, reject) => {
    const req = http.request({ socketPath: INCUS_SOCKET, path: p, method, headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const contentType = String(res.headers['content-type'] || '');
        let json = null;
        if (contentType.includes('json') || raw[0] === 0x7b || raw[0] === 0x5b) { try { json = JSON.parse(raw.toString('utf8')); } catch {} }
        const result = { status_code: res.statusCode, headers: res.headers, body: raw, json };
        if ((res.statusCode || 500) >= 400) {
          reject(new SezuError('incus_error', json?.error || `Incus returned HTTP ${res.statusCode}`, { status_code: res.statusCode, response: json || raw.toString('utf8').slice(0, 4096) }));
        } else resolve(result);
      });
    });
    req.on('error', reject); if (body) req.write(body); req.end();
  });
}

export async function incusJson(method, p, options = {}) {
  const r = await incusRequest(method, p, options);
  return r.json ?? { status_code: r.status_code, body_base64: r.body.toString('base64') };
}

export async function waitIncusOperation(operation, timeoutMs = 60000) {
  const opPath = String(operation).startsWith('/1.0/operations/') ? String(operation) : `/1.0/operations/${String(operation).replace(/^.*\//, '')}`;
  const deadline = Date.now() + boundedInt(timeoutMs, 'timeout_ms', 60000, 24 * 60 * 60 * 1000);
  while (true) {
    const response = await incusJson('GET', opPath);
    const meta = response.metadata || response;
    if ([200, 400, 401, 103, 104, 105, 106].includes(meta.status_code) && !['Running', 'Pending'].includes(meta.status)) return meta;
    if (Date.now() >= deadline) throw new SezuError('incus_timeout', `Incus operation did not complete: ${opPath}`, { operation: opPath });
    await new Promise(r => setTimeout(r, 250));
  }
}

export function operationUrl(response) {
  return response?.operation || response?.metadata?.operation || response?.metadata?.id || null;
}

export async function runIncusCli(args, options = {}) {
  const r = await runProcess(['incus', ...args.map(String)], options);
  const stdout = await fsp.readFile(r.stdoutPath);
  const stderr = await fsp.readFile(r.stderrPath);
  await fsp.rm(r.tempDir, { recursive: true, force: true });
  if (r.code !== 0) throw new SezuError('incus_cli_failed', stderr.toString('utf8').trim() || `incus exited ${r.code}`, { argv: args, exit_code: r.code, signal: r.signal, stdout: stdout.toString('utf8') });
  return { stdout, stderr, exit_code: r.code, signal: r.signal };
}

export function encodeFrame(value) {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > MAX_FRAME) throw new SezuError('frame_too_large', `frame exceeds ${MAX_FRAME} bytes`);
  const header = Buffer.alloc(4); header.writeUInt32BE(body.length); return Buffer.concat([header, body]);
}

export function frameReader(onFrame, onError = () => {}) {
  let buffer = Buffer.alloc(0);
  return chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const size = buffer.readUInt32BE(0);
      if (size > MAX_FRAME) { onError(new SezuError('frame_too_large', `frame exceeds ${MAX_FRAME} bytes`)); buffer = Buffer.alloc(0); return; }
      if (buffer.length < size + 4) return;
      const body = buffer.subarray(4, size + 4); buffer = buffer.subarray(size + 4);
      try { onFrame(JSON.parse(body.toString('utf8'))); } catch (e) { onError(new SezuError('malformed_json', e.message)); }
    }
  };
}

export async function socketCall(request, socketPath = SOCKET_PATH, timeoutMs = 0) {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let timer = null; let settled = false;
    if (timeoutMs > 0) timer = setTimeout(() => { socket.destroy(); reject(new SezuError('socket_timeout', 'supervisor response timed out')); }, timeoutMs);
    const finish = fn => value => { if (settled) return; settled = true; if (timer) clearTimeout(timer); socket.destroy(); fn(value); };
    const reader = frameReader(finish(resolve), finish(reject));
    socket.on('connect', () => socket.write(encodeFrame(request)));
    socket.on('data', reader); socket.on('error', finish(reject));
    socket.on('end', () => { if (!settled) finish(reject)(new SezuError('socket_closed', 'supervisor closed without a response')); });
  });
}

export async function initializeState() {
  for (const [key, dir] of Object.entries(ROOTS)) if (!['skillsBuiltin', 'skillsOwner', 'macros', 'release', 'config', 'cache'].includes(key)) await ensureDir(dir);
  await ensureDir(path.join(ROOTS.artifacts, 'sha256')); await ensureDir(path.join(ROOTS.artifacts, 'metadata')); await ensureDir(path.join(ROOTS.artifacts, 'uploads'));
  await ensureDir(ROOTS.skillsOwner, 0o755); await ensureDir(ROOTS.macros, 0o755);
}
