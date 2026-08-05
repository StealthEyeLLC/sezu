import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import {
  ROOTS, PROJECT, INLINE_LIMIT, SezuError, artifactFromFile, artifactPath, asArray,
  asObject, asString, atomicJson, boundedInt, decodeData, digestFile, encodeData,
  ensureDir, exists, now, readJson, readRange, required, runIncusCli, runProcess,
  safeName, sha256, stableStringify, targetInstance, uuid
} from './util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACK_LOCK = path.resolve(HERE, '../locks/capability-packs.json');
const TRANSFERS = path.join(ROOTS.storage, 'transfers');
const BROWSER_SESSIONS = path.join(ROOTS.browser, '.sessions');
const BASE_PACKS = new Set(['sezu-core', 'data-core', 'document-core', 'wasm-core', 'network-core', 'machine-image-core', 'cross-build-core']);

async function call(runtime, operation, target, args) {
  const response = await runtime.dispatch({ operation, target, args, request_id: uuid() });
  if (!response.ok) throw new SezuError(response.error?.code || 'operation_failed', response.error?.message || `${operation} failed`, response.error?.details);
  return response;
}

async function hostCommand(argv, options = {}) {
  const r = await runProcess(argv, options);
  const stdout = await fsp.readFile(r.stdoutPath); const stderr = await fsp.readFile(r.stderrPath);
  await fsp.rm(r.tempDir, { recursive: true, force: true });
  if (r.code !== 0 || r.signal) throw new SezuError(options.code || 'command_failed', stderr.toString('utf8').trim() || `${argv[0]} failed`, { argv, exit_code: r.code, signal: r.signal, stdout: stdout.toString('utf8') });
  return { stdout, stderr };
}

async function parseDataFile(file) {
  const text = await fsp.readFile(file, 'utf8');
  if (file.endsWith('.yaml') || file.endsWith('.yml')) return YAML.parse(text);
  return JSON.parse(text);
}

async function findManifest(dir, names) {
  for (const name of names) { const file = path.join(dir, name); if (await exists(file)) return { file, value: await parseDataFile(file) }; }
  return null;
}

function transferPaths(id) {
  safeName(id, 'transfer_id'); const dir = path.join(TRANSFERS, id);
  return { dir, metadata: path.join(dir, 'metadata.json'), staging: path.join(dir, 'staging') };
}

async function getTransfer(id) {
  const p = transferPaths(id); const record = await readJson(p.metadata, null);
  if (!record) throw new SezuError('transfer_not_found', `transfer not found: ${id}`);
  return { ...p, record };
}

function endpoint(value, defaultTarget) {
  if (typeof value === 'string') return { kind: 'target', target: defaultTarget, path: value };
  const e = asObject(value, 'endpoint');
  if (e.artifact_id || e.artifact) return { kind: 'artifact', artifact_id: e.artifact_id || e.artifact };
  if (e.url) return { kind: 'url', url: e.url };
  if (e.git || e.repository) return { kind: 'git', repository: e.repository || e.git.repository || e.git, ref: e.ref || e.git.ref };
  if (e.oci) return { kind: 'oci', reference: e.oci, format: e.format || 'dir' };
  if (e.s3) return { kind: 's3', source: e.s3 };
  if (e.path) return { kind: 'target', target: e.target || defaultTarget, path: e.path };
  throw new SezuError('invalid_request', 'endpoint must specify path, artifact, URL, Git, OCI, or S3');
}

async function copyTargetToHost(source, destination, preserve = true) {
  await ensureDir(path.dirname(destination));
  if (source.target === 'host') {
    const stat = await fsp.lstat(source.path);
    if (stat.isDirectory()) await hostCommand(['rsync', '-a', ...(preserve ? ['-HAXS'] : []), `${source.path.replace(/\/$/, '')}/`, destination]);
    else await hostCommand(['rsync', ...(preserve ? ['-aHAXS'] : []), '--partial', '--append-verify', source.path, destination]);
  } else {
    const instance = targetInstance(source.target); if (!instance) throw new SezuError('invalid_target', 'invalid transfer source target');
    const probe = await runProcess(['incus', 'exec', instance, '--project', PROJECT, '--', 'test', '-d', source.path]);
    const isDirectory = probe.code === 0; await fsp.rm(probe.tempDir, { recursive: true, force: true });
    await fsp.rm(destination, { recursive: true, force: true });
    if (isDirectory) {
      await ensureDir(destination);
      await hostCommand(['/bin/bash', '-lc', 'set -euo pipefail; incus exec "$1" --project "$2" -- tar --xattrs --acls --sparse -C "$3" -cpf - . | tar --xattrs --acls --sparse -C "$4" -xpf -', 'bash', instance, PROJECT, source.path, destination]);
    } else {
      await ensureDir(path.dirname(destination));
      await runIncusCli(['file', 'pull', `${instance}${source.path}`, destination, '--project', PROJECT]);
    }
  }
}

async function copyHostToTarget(source, destination, preserve = true) {
  if (destination.target === 'host') {
    await ensureDir(path.dirname(destination.path));
    const stat = await fsp.lstat(source);
    if (stat.isDirectory()) { await ensureDir(destination.path); await hostCommand(['rsync', '-a', ...(preserve ? ['-HAXS'] : []), `${source.replace(/\/$/, '')}/`, `${destination.path.replace(/\/$/, '')}/`]); }
    else await hostCommand(['rsync', ...(preserve ? ['-aHAXS'] : []), '--partial', '--append-verify', source, destination.path]);
  } else {
    const instance = targetInstance(destination.target); if (!instance) throw new SezuError('invalid_target', 'invalid transfer destination target');
    const stat = await fsp.lstat(source);
    if (stat.isDirectory()) {
      await hostCommand(['/bin/bash', '-lc', 'set -euo pipefail; incus exec "$2" --project "$3" -- mkdir -p "$4"; tar --xattrs --acls --sparse -C "$1" -cpf - . | incus exec "$2" --project "$3" -- tar --xattrs --acls --sparse -C "$4" -xpf -', 'bash', source, instance, PROJECT, destination.path]);
    } else {
      await runIncusCli(['exec', instance, '--project', PROJECT, '--', 'mkdir', '-p', path.dirname(destination.path)]);
      await runIncusCli(['file', 'push', source, `${instance}${destination.path}`, '--project', PROJECT]);
    }
  }
}

async function materializeSource(source, staging, record, resume = false) {
  if (!resume) await fsp.rm(staging, { recursive: true, force: true });
  if (source.kind === 'target') await copyTargetToHost(source, staging, record.preserve);
  else if (source.kind === 'artifact') {
    const p = artifactPath(source.artifact_id); if (!(await exists(p.file))) throw new SezuError('artifact_not_found', `artifact not found: ${source.artifact_id}`); await fsp.copyFile(p.file, staging);
  } else if (source.kind === 'url') {
    await ensureDir(path.dirname(staging)); await hostCommand(['curl', '--fail', '--location', '--continue-at', '-', '--output', staging, source.url]);
  } else if (source.kind === 'git') {
    if (!source.ref) throw new SezuError('configuration_required', 'an exact Git ref is required');
    await hostCommand(['git', 'clone', '--no-checkout', source.repository, staging]);
    await hostCommand(['git', '-C', staging, 'checkout', '--detach', source.ref]);
  } else if (source.kind === 'oci') {
    await ensureDir(staging); await hostCommand(['skopeo', 'copy', `docker://${source.reference}`, `dir:${staging}`]);
  } else if (source.kind === 's3') {
    if (!(await commandExists('rclone'))) throw new SezuError('configuration_required', 'rclone is required for S3 transfers and no S3 client is configured');
    await hostCommand(['rclone', 'copyto', source.source, staging, '--partial-suffix', '.partial']);
  }
  return staging;
}

async function deliverDestination(staging, destination, record) {
  if (destination.kind === 'target') { await copyHostToTarget(staging, destination, record.preserve); return { destination }; }
  if (destination.kind === 'artifact') return { artifact: await artifactFromFile(staging, { name: record.name || path.basename(staging), transfer_id: record.transfer_id }) };
  if (destination.kind === 'url') throw new SezuError('configuration_required', 'URL export requires an explicit upload command or S3-compatible destination');
  if (destination.kind === 's3') {
    if (!(await commandExists('rclone'))) throw new SezuError('configuration_required', 'rclone is required for S3 transfers and no S3 client is configured');
    await hostCommand(['rclone', 'copyto', staging, destination.source]); return { destination };
  }
  throw new SezuError('invalid_request', `unsupported transfer destination kind: ${destination.kind}`);
}

async function commandExists(name) {
  const r = await runProcess(['/bin/sh', '-c', 'command -v "$1" >/dev/null 2>&1', 'sh', name]); const ok = r.code === 0; await fsp.rm(r.tempDir, { recursive: true, force: true }); return ok;
}

async function runTransfer(runtime, record, options = {}) {
  const p = transferPaths(record.transfer_id);
  record.state = 'running'; record.updated_at = now(); await atomicJson(p.metadata, record);
  try {
    const staging = await materializeSource(record.source, p.staging, record, options.resume === true);
    const stat = await fsp.stat(staging);
    record.bytes_total = stat.isFile() ? stat.size : null;
    const delivered = await deliverDestination(staging, record.destination, record);
    record.state = 'completed'; record.completed_at = now(); record.updated_at = now(); record.bytes_transferred = record.bytes_total; record.result = delivered;
    await atomicJson(p.metadata, record); return record;
  } catch (e) {
    record.state = 'failed'; record.updated_at = now(); record.error = { code: e.code || 'transfer_failed', message: e.message, details: e.details || null };
    try { const stat = await fsp.stat(p.staging); record.bytes_transferred = stat.isFile() ? stat.size : null; } catch {}
    await atomicJson(p.metadata, record); throw e;
  }
}

function profilePaths(name) {
  safeName(name, 'profile name'); const dir = path.join(ROOTS.browser, name);
  return { dir, metadata: path.join(dir, 'profile.json'), data: path.join(dir, 'data'), downloads: path.join(dir, 'downloads'), staging: path.join(dir, 'uploads') };
}
async function getProfile(name) {
  const p = profilePaths(name); const metadata = await readJson(p.metadata, null);
  if (!metadata) throw new SezuError('browser_profile_not_found', `browser profile not found: ${name}`);
  return { ...p, record: metadata };
}

async function listSkills() {
  const active = await readJson(path.join(ROOTS.workspaces, 'active.json'), null); const roots = [
    { scope: 'builtin', root: ROOTS.skillsBuiltin }, { scope: 'owner', root: ROOTS.skillsOwner }
  ];
  if (active?.path) roots.push({ scope: 'workspace', root: path.join(active.path, '.sezu', 'skills') });
  const skills = [];
  for (const source of roots) {
    if (!(await exists(source.root))) continue;
    for (const e of await fsp.readdir(source.root, { withFileTypes: true })) {
      if (!e.isDirectory()) continue; const dir = path.join(source.root, e.name); const manifest = await findManifest(dir, ['skill.json', 'skill.yaml', 'skill.yml']);
      if (manifest) skills.push({ ...manifest.value, scope: source.scope, directory: dir, manifest: manifest.file });
    }
  }
  return skills;
}

async function findSkill(name) {
  const skills = await listSkills(); const matches = skills.filter(s => s.name === name);
  if (!matches.length) throw new SezuError('skill_not_found', `skill not found: ${name}`);
  return matches.at(-1);
}

async function listMacros() {
  const active = await readJson(path.join(ROOTS.workspaces, 'active.json'), null); const roots = [ROOTS.macros]; if (active?.path) roots.push(path.join(active.path, '.sezu', 'macros'));
  const out = [];
  for (const root of roots) {
    if (!(await exists(root))) continue;
    for (const e of await fsp.readdir(root, { withFileTypes: true })) if (e.isFile() && /\.(json|ya?ml)$/.test(e.name)) {
      const file = path.join(root, e.name); const value = await parseDataFile(file); out.push({ ...value, file, scope: root === ROOTS.macros ? 'owner' : 'workspace' });
    }
  }
  return out;
}

function lookup(object, expression) {
  return expression.split('.').reduce((v, key) => v === undefined || v === null ? undefined : v[key], object);
}
function interpolate(value, context) {
  if (Array.isArray(value)) return value.map(v => interpolate(v, context));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, context)]));
  if (typeof value !== 'string') return value;
  const exact = value.match(/^\$\{([^}]+)\}$/); if (exact) return lookup(context, exact[1]);
  return value.replace(/\$\{([^}]+)\}/g, (_, expr) => String(lookup(context, expr) ?? ''));
}

async function loadPackLock() {
  return await readJson(PACK_LOCK);
}
async function packRecord(target, packId) {
  const targetKey = target.replace(/[:/]/g, '_'); return path.join(ROOTS.packs, targetKey, `${packId}.json`);
}

async function instanceIPv4(name) {
  const result = await runIncusCli(['list', name, '--project', PROJECT, '--format', 'json']);
  const items = JSON.parse(result.stdout.toString('utf8'));
  const item = items.find(x => x.name === name);
  const networks = item?.state?.network || {};
  const ordered = [networks.eth0, ...Object.entries(networks).filter(([name]) => name !== 'eth0' && !/^(docker|br-|veth)/.test(name)).map(([, value]) => value)].filter(Boolean);
  for (const network of ordered) {
    const address = (network.addresses || []).find(x => x.family === 'inet' && x.scope === 'global');
    if (address?.address) return address.address;
  }
  throw new SezuError('target_unreachable', `no global IPv4 address is available for ${name}`);
}

async function stopTemporaryJob(runtime, jobId) {
  if (!jobId) return;
  try { await call(runtime, 'sezu.job.cancel', 'host', { job_id: jobId }); } catch {}
  try { await call(runtime, 'sezu.job.wait', 'host', { job_id: jobId, timeout_ms: 10000 }); } catch {}
  try { await call(runtime, 'sezu.job.delete', 'host', { job_id: jobId }); } catch {}
}

export function registerStateOperations(runtime) {
  runtime.register('sezu.transfer.start', async function (args, target) {
    const id = args.transfer_id ? safeName(args.transfer_id, 'transfer_id') : uuid(); const p = transferPaths(id); if (await exists(p.metadata)) throw new SezuError('transfer_exists', `transfer already exists: ${id}`);
    await ensureDir(p.dir); const record = { transfer_id: id, name: args.name || null, source: endpoint(required(args, 'source'), target), destination: endpoint(required(args, 'destination'), target), preserve: args.preserve !== false, state: 'pending', created_at: now(), updated_at: now(), bytes_total: null, bytes_transferred: 0, result: null, error: null };
    await atomicJson(p.metadata, record); const completed = await runTransfer(this, record); return { status: completed.state, handle: id, result: completed };
  }, { family: 'transfer' });
  runtime.register('sezu.transfer.status', async args => ({ status: (await getTransfer(required(args, 'transfer_id', 'string'))).record.state, handle: args.transfer_id, result: (await getTransfer(args.transfer_id)).record }), { mutating: false, family: 'transfer' });
  runtime.register('sezu.transfer.resume', async function (args) { const t = await getTransfer(required(args, 'transfer_id', 'string')); if (t.record.state === 'completed') return { status: 'completed', handle: t.record.transfer_id, result: t.record }; t.record.error = null; return { status: 'completed', handle: t.record.transfer_id, result: await runTransfer(this, t.record, { resume: true }) }; }, { family: 'transfer' });
  runtime.register('sezu.transfer.cancel', async args => { const t = await getTransfer(required(args, 'transfer_id', 'string')); if (t.record.state === 'running') throw new SezuError('transfer_busy', 'synchronous transfer cannot be cancelled between atomic filesystem operations; retry after the current operation returns'); t.record.state = 'cancelled'; t.record.cancelled_at = now(); await atomicJson(t.metadata, t.record); if (args.remove_partial) await fsp.rm(t.staging, { recursive: true, force: true }); return { status: 'cancelled', handle: t.record.transfer_id, result: t.record }; }, { family: 'transfer' });
  runtime.register('sezu.source.import', async function (args, target) { return await this.handlers.get('sezu.transfer.start').call(this, { source: args.source || args, destination: args.destination || { target, path: required(args, 'path', 'string') }, preserve: args.preserve }, target, { operation: 'sezu.transfer.start' }); }, { family: 'transfer' });
  runtime.register('sezu.source.export', async function (args, target) { return await this.handlers.get('sezu.transfer.start').call(this, { source: args.source || { target, path: required(args, 'path', 'string') }, destination: required(args, 'destination'), preserve: args.preserve }, target, { operation: 'sezu.transfer.start' }); }, { family: 'transfer' });

  runtime.register('sezu.archive.create', async function (args, target) {
    const format = args.format || inferArchiveFormat(required(args, 'destination', 'string')); const sources = asArray(args.sources || [required(args, 'source', 'string')], 'sources'); const dest = args.destination;
    let argv;
    if (format === 'tar' || format === 'tar.gz' || format === 'tgz' || format === 'tar.xz') argv = ['tar', format.includes('gz') || format === 'tgz' ? '-czf' : (format.includes('xz') ? '-cJf' : '-cf'), dest, ...sources];
    else if (format === 'zip') argv = ['zip', '-r', dest, ...sources];
    else if (format === '7z') argv = ['7z', 'a', dest, ...sources];
    else if (format === 'cpio') argv = ['sh', '-c', `dest="$1"; shift; printf '%s\\n' "$@" | cpio -o -H newc > "$dest"`, 'sh', dest, ...sources];
    else if (format === 'squashfs') argv = ['mksquashfs', ...sources, dest, '-noappend'];
    else throw new SezuError('invalid_request', `unsupported archive format: ${format}`);
    const response = await call(this, 'sezu.exec', target, { argv, cwd: args.cwd || '/', timeout_ms: args.timeout_ms });
    if (args.artifact) {
      const temp = path.join(ROOTS.storage, `archive-${uuid()}`); await copyTargetToHost({ kind: 'target', target, path: dest }, temp, true); const artifact = await artifactFromFile(temp, { name: path.basename(dest), format }); await fsp.rm(temp, { recursive: true, force: true }); return { artifacts: [artifact], result: { format, destination: dest, artifact } };
    }
    return { result: { format, destination: dest, execution: response.result } };
  }, { family: 'archive' });
  runtime.register('sezu.archive.extract', async function (args, target) {
    let source = required(args, 'source'); const destination = required(args, 'destination', 'string'); let cleanup = null;
    if (typeof source === 'object' && (source.artifact || source.artifact_id)) { cleanup = `/tmp/sezu-archive-${uuid()}`; await this.handlers.get('sezu.artifact.copy').call(this, { artifact_id: source.artifact || source.artifact_id, path: cleanup }, target, { operation: 'sezu.artifact.copy' }); source = cleanup; }
    const format = args.format || inferArchiveFormat(String(source)); let argv;
    await call(this, 'sezu.file.mkdir', target, { path: destination, parents: true });
    if (format.startsWith('tar') || format === 'tgz') argv = ['tar', '-xf', String(source), '-C', destination];
    else if (format === 'zip') argv = ['unzip', '-o', String(source), '-d', destination];
    else if (format === '7z') argv = ['7z', 'x', `-o${destination}`, '-y', String(source)];
    else if (format === 'cpio') argv = ['sh', '-c', 'cd "$1" && cpio -idmv < "$2"', 'sh', destination, String(source)];
    else if (format === 'squashfs') argv = ['unsquashfs', '-f', '-d', destination, String(source)];
    else throw new SezuError('invalid_request', `unsupported archive format: ${format}`);
    await call(this, 'sezu.exec', target, { argv, timeout_ms: args.timeout_ms }); if (cleanup) await call(this, 'sezu.file.remove', target, { path: cleanup });
    return { result: { format, source, destination } };
  }, { family: 'archive' });

  runtime.register('sezu.artifact.begin', async args => {
    const id = args.upload_id ? safeName(args.upload_id, 'upload_id') : uuid(); const dir = path.join(ROOTS.artifacts, 'uploads', id); if (await exists(dir)) throw new SezuError('artifact_upload_exists', `upload already exists: ${id}`);
    await ensureDir(dir); await fsp.writeFile(path.join(dir, 'data'), Buffer.alloc(0), { mode: 0o600 }); const record = { upload_id: id, name: args.name || null, expected_size: args.expected_size ?? null, expected_sha256: args.expected_sha256 || null, ranges: [], bytes: 0, state: 'uploading', created_at: now(), metadata: args.metadata || {} }; await atomicJson(path.join(dir, 'metadata.json'), record, 0o600); return { status: 'running', handle: id, result: record };
  }, { family: 'artifact' });
  runtime.register('sezu.artifact.upload', async args => {
    const id = required(args, 'upload_id', 'string'); const dir = path.join(ROOTS.artifacts, 'uploads', safeName(id, 'upload_id')); const metaFile = path.join(dir, 'metadata.json'); const record = await readJson(metaFile, null); if (!record) throw new SezuError('artifact_upload_not_found', `upload not found: ${id}`);
    const data = decodeData({ ...args, encoding: args.encoding || 'base64' }); const offset = boundedInt(args.offset, 'offset', record.bytes || 0); const handle = await fsp.open(path.join(dir, 'data'), 'r+'); try { await handle.write(data, 0, data.length, offset); if (args.durable) await handle.sync(); } finally { await handle.close(); }
    record.ranges = mergeRanges([...record.ranges, [offset, offset + data.length]]); record.bytes = Math.max(record.bytes, offset + data.length); record.updated_at = now(); await atomicJson(metaFile, record, 0o600); return { status: 'running', handle: id, result: { upload_id: id, offset, next_offset: offset + data.length, bytes: record.bytes, ranges: record.ranges } };
  }, { family: 'artifact' });
  runtime.register('sezu.artifact.finalize', async args => {
    const id = required(args, 'upload_id', 'string'); const dir = path.join(ROOTS.artifacts, 'uploads', safeName(id, 'upload_id')); const record = await readJson(path.join(dir, 'metadata.json'), null); if (!record) throw new SezuError('artifact_upload_not_found', `upload not found: ${id}`); const file = path.join(dir, 'data'); const stat = await fsp.stat(file); const expectedSize = args.expected_size ?? record.expected_size ?? stat.size; const expectedDigest = args.expected_sha256 || record.expected_sha256;
    if (record.ranges.length !== 1 || record.ranges[0][0] !== 0 || record.ranges[0][1] !== expectedSize || stat.size !== expectedSize) throw new SezuError('artifact_incomplete', 'artifact upload does not contain a complete contiguous byte range', { size: stat.size, expected_size: expectedSize, ranges: record.ranges });
    const digest = await digestFile(file); if (expectedDigest && digest !== expectedDigest) throw new SezuError('artifact_digest_mismatch', 'artifact SHA-256 does not match', { actual: digest, expected: expectedDigest });
    const artifact = await artifactFromFile(file, { ...record.metadata, name: record.name, upload_id: id }); await fsp.rm(dir, { recursive: true, force: true }); return { handle: artifact.artifact_id, artifacts: [artifact], result: artifact };
  }, { family: 'artifact' });
  runtime.register('sezu.artifact.abort', async args => { const id = safeName(required(args, 'upload_id', 'string'), 'upload_id'); const dir = path.join(ROOTS.artifacts, 'uploads', id); if (!(await exists(dir))) throw new SezuError('artifact_upload_not_found', `upload not found: ${id}`); await fsp.rm(dir, { recursive: true, force: true }); return { status: 'cancelled', handle: id, result: { aborted: id } }; }, { family: 'artifact' });
  runtime.register('sezu.artifact.get', async args => { const p = artifactPath(required(args, 'artifact_id', 'string')); const metadata = await readJson(p.metadata, null); if (!metadata || !(await exists(p.file))) throw new SezuError('artifact_not_found', `artifact not found: ${args.artifact_id}`); return { handle: metadata.artifact_id, result: metadata }; }, { mutating: false, family: 'artifact' });
  runtime.register('sezu.artifact.read', async args => { const p = artifactPath(required(args, 'artifact_id', 'string')); if (!(await exists(p.file))) throw new SezuError('artifact_not_found', `artifact not found: ${args.artifact_id}`); const range = await readRange(p.file, args.offset || 0, args.limit || INLINE_LIMIT); return { handle: `sha256:${p.digest}`, result: { data: encodeData(range.buffer, args.encoding || 'base64'), encoding: args.encoding || 'base64', offset: range.offset, next_offset: range.next_offset, size: range.size, eof: range.eof } }; }, { mutating: false, family: 'artifact' });
  runtime.register('sezu.artifact.list', async args => { const dir = path.join(ROOTS.artifacts, 'metadata'); await ensureDir(dir); const items = []; for (const e of await fsp.readdir(dir, { withFileTypes: true })) if (e.isFile() && e.name.endsWith('.json')) { const m = await readJson(path.join(dir, e.name), null); if (m) items.push(m); } items.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))); return { result: { artifacts: items.slice(0, args.limit || 1000), count: items.length } }; }, { mutating: false, family: 'artifact' });
  runtime.register('sezu.artifact.copy', async (args, target) => { const p = artifactPath(required(args, 'artifact_id', 'string')); if (!(await exists(p.file))) throw new SezuError('artifact_not_found', `artifact not found: ${args.artifact_id}`); const destination = endpoint({ target: args.target || target, path: required(args, 'path', 'string') }, target); await copyHostToTarget(p.file, destination, args.preserve !== false); return { handle: `sha256:${p.digest}`, result: { artifact_id: `sha256:${p.digest}`, destination } }; }, { family: 'artifact' });
  runtime.register('sezu.artifact.delete', async args => { const p = artifactPath(required(args, 'artifact_id', 'string')); if (!(await exists(p.file))) throw new SezuError('artifact_not_found', `artifact not found: ${args.artifact_id}`); await fsp.rm(p.file, { force: true }); await fsp.rm(p.metadata, { force: true }); return { result: { deleted: `sha256:${p.digest}` } }; }, { family: 'artifact' });

  runtime.register('sezu.workspace.list', async () => { await ensureDir(ROOTS.workspaces); const items = []; for (const e of await fsp.readdir(ROOTS.workspaces, { withFileTypes: true })) if (e.isFile() && e.name.endsWith('.json') && e.name !== 'active.json') { const w = await readJson(path.join(ROOTS.workspaces, e.name), null); if (w) items.push(w); } return { result: { workspaces: items, active: await readJson(path.join(ROOTS.workspaces, 'active.json'), null) } }; }, { mutating: false, family: 'workspace' });
  runtime.register('sezu.workspace.open', async function (args) { let value; let workspacePath = args.path || null; if (workspacePath) { const config = await findManifest(path.join(workspacePath, '.sezu'), ['workspace.yaml', 'workspace.yml', 'workspace.json']); value = config ? config.value : { name: path.basename(workspacePath), default_target: args.default_target || 'u' }; } else { const name = safeName(required(args, 'name', 'string'), 'workspace name'); value = await readJson(path.join(ROOTS.workspaces, `${name}.json`), null); if (!value) throw new SezuError('workspace_not_found', `workspace not found: ${name}`); workspacePath = value.path || null; } value = { ...value, ...args.overrides, name: value.name || args.name || path.basename(workspacePath), path: workspacePath, opened_at: now() }; await atomicJson(path.join(ROOTS.workspaces, `${safeName(value.name, 'workspace name')}.json`), value); await atomicJson(path.join(ROOTS.workspaces, 'active.json'), value); if (args.create_terminals !== false) for (const name of value.terminals || []) { try { await call(this, 'sezu.terminal.create', value.default_target || 'u', { name, workspace: value.name }); } catch (e) { if (e.code !== 'terminal_exists') throw e; } } return { result: value }; }, { family: 'workspace' });
  runtime.register('sezu.workspace.get', async args => { const value = args.name ? await readJson(path.join(ROOTS.workspaces, `${safeName(args.name, 'workspace name')}.json`), null) : await readJson(path.join(ROOTS.workspaces, 'active.json'), null); if (!value) throw new SezuError('workspace_not_found', 'workspace not found'); return { result: value }; }, { mutating: false, family: 'workspace' });
  runtime.register('sezu.workspace.set', async args => { const current = args.name ? await readJson(path.join(ROOTS.workspaces, `${safeName(args.name, 'workspace name')}.json`), null) : await readJson(path.join(ROOTS.workspaces, 'active.json'), null); if (!current) throw new SezuError('workspace_not_found', 'workspace not found'); const value = { ...current, ...asObject(required(args, 'values'), 'values'), updated_at: now() }; const file = path.join(ROOTS.workspaces, `${safeName(value.name, 'workspace name')}.json`); await atomicJson(file, value); const active = await readJson(path.join(ROOTS.workspaces, 'active.json'), null); if (active?.name === value.name) await atomicJson(path.join(ROOTS.workspaces, 'active.json'), value); return { result: value }; }, { family: 'workspace' });
  runtime.register('sezu.workspace.close', async () => { const active = await readJson(path.join(ROOTS.workspaces, 'active.json'), null); await fsp.rm(path.join(ROOTS.workspaces, 'active.json'), { force: true }); return { result: { closed: active?.name || null } }; }, { family: 'workspace' });
  runtime.register('sezu.workspace.delete', async args => { const name = safeName(required(args, 'name', 'string'), 'workspace name'); const active = await readJson(path.join(ROOTS.workspaces, 'active.json'), null); if (active?.name === name) await fsp.rm(path.join(ROOTS.workspaces, 'active.json'), { force: true }); await fsp.rm(path.join(ROOTS.workspaces, `${name}.json`), { force: true }); return { result: { deleted: name } }; }, { family: 'workspace' });

  runtime.register('sezu.skill.list', async () => ({ result: { skills: await listSkills() } }), { mutating: false, family: 'skill' });
  runtime.register('sezu.skill.inspect', async args => ({ result: await findSkill(required(args, 'name', 'string')) }), { mutating: false, family: 'skill' });
  runtime.register('sezu.skill.install', async function (args) { const source = required(args, 'source'); const temp = await fsp.mkdtemp(path.join(ROOTS.storage, 'skill-')); let sourceDir = null; try { if (typeof source === 'string') sourceDir = source; else if (source.path) sourceDir = source.path; else if (source.artifact_id || source.artifact) { const p = artifactPath(source.artifact_id || source.artifact); await hostCommand(['tar', '-xf', p.file, '-C', temp]); sourceDir = temp; } else if (source.git || source.repository) { const repo = source.repository || source.git; if (!source.ref) throw new SezuError('configuration_required', 'skill installation from Git requires an exact ref'); sourceDir = path.join(temp, 'source'); await hostCommand(['git', 'clone', '--no-checkout', repo, sourceDir]); await hostCommand(['git', '-C', sourceDir, 'checkout', '--detach', source.ref]); if (source.path) sourceDir = path.join(sourceDir, source.path); } else if (source.oci) { sourceDir = path.join(temp, 'oci'); await ensureDir(sourceDir); await hostCommand(['skopeo', 'copy', `docker://${source.oci}`, `dir:${sourceDir}`]); } else throw new SezuError('invalid_request', 'unsupported skill source'); const manifest = await findManifest(sourceDir, ['skill.json', 'skill.yaml', 'skill.yml']); if (!manifest) throw new SezuError('invalid_skill', 'skill manifest is missing'); const name = safeName(manifest.value.name, 'skill name'); const destination = path.join(ROOTS.skillsOwner, name); await fsp.rm(destination, { recursive: true, force: true }); await hostCommand(['cp', '-a', sourceDir, destination]); return { result: { ...manifest.value, scope: 'owner', directory: destination } }; } finally { await fsp.rm(temp, { recursive: true, force: true }); } }, { family: 'skill' });
  runtime.register('sezu.skill.remove', async args => { const skill = await findSkill(required(args, 'name', 'string')); if (skill.scope === 'builtin') throw new SezuError('immutable_builtin', 'built-in skills cannot be removed through owner-installed skill state'); await fsp.rm(skill.directory, { recursive: true, force: true }); return { result: { removed: skill.name, scope: skill.scope } }; }, { family: 'skill' });
  runtime.register('sezu.skill.run', async function (args, target) { const skill = await findSkill(required(args, 'name', 'string')); const entrypoint = path.resolve(skill.directory, skill.entrypoint); if (!entrypoint.startsWith(path.resolve(skill.directory) + path.sep)) throw new SezuError('invalid_skill', 'skill entrypoint escapes its directory'); const selectedTarget = args.target || skill.default_target || target; const argv = [entrypoint, JSON.stringify(args.input || args.args || {})]; return await call(this, 'sezu.exec', selectedTarget, { argv, cwd: args.cwd || skill.directory, env: { ...(skill.environment || {}), ...(args.env || {}) }, timeout_ms: args.timeout_ms }); }, { family: 'skill' });

  runtime.register('sezu.macro.list', async () => ({ result: { macros: await listMacros() } }), { mutating: false, family: 'macro' });
  runtime.register('sezu.macro.inspect', async args => { const macro = (await listMacros()).find(x => x.name === required(args, 'name', 'string')); if (!macro) throw new SezuError('macro_not_found', `macro not found: ${args.name}`); return { result: macro }; }, { mutating: false, family: 'macro' });
  runtime.register('sezu.macro.run', async function (args, defaultTarget) { const macro = args.macro || (await listMacros()).find(x => x.name === required(args, 'name', 'string')); if (!macro) throw new SezuError('macro_not_found', `macro not found: ${args.name}`); const context = { inputs: args.inputs || {}, steps: [] }; const executeStep = async (step, index) => { const rendered = interpolate(step, context); const targets = rendered.targets || [rendered.target || defaultTarget]; const responses = await Promise.all(targets.map(t => this.dispatch({ operation: rendered.operation, target: t, args: rendered.args || {}, request_id: uuid() }))); const response = responses.length === 1 ? responses[0] : responses; context.steps[index] = { response, result: responses.length === 1 ? response.result : responses.map(x => x.result) }; return { index, responses }; }; let results = []; if ((macro.mode || 'sequential') === 'parallel') results = await Promise.all(macro.steps.map(executeStep)); else { const pending = new Map(macro.steps.map((s, i) => [i, s])); while (pending.size) { const ready = [...pending].filter(([i, s]) => (s.depends_on || []).every(d => context.steps[d])); if (!ready.length) throw new SezuError('dependency_deadlock', 'macro dependencies cannot be satisfied'); const batch = macro.mode === 'dependency' ? await Promise.all(ready.map(([i, s]) => executeStep(s, i))) : [await executeStep(ready[0][1], ready[0][0])]; results.push(...batch); for (const r of batch) pending.delete(r.index); } } results.sort((a, b) => a.index - b.index); const ok = results.every(r => r.responses.every(x => x.ok)); return { ok, status: ok ? 'completed' : 'failed', result: { name: macro.name, results, context } }; }, { family: 'macro' });

  runtime.register('sezu.pack.list', async (args, target) => { const lock = await loadPackLock(); const packs = []; for (const pack of lock.packs) { const state = await readJson(await packRecord(target, pack.pack_id), null); packs.push({ ...pack, status: BASE_PACKS.has(pack.pack_id) && target === 'u' ? 'built-in' : (state?.state || 'not-installed'), installed_state: state }); } return { result: { target, packs, count: packs.length } }; }, { mutating: false, family: 'pack' });
  runtime.register('sezu.pack.status', async (args, target) => { const id = required(args, 'pack_id', 'string'); const lock = await loadPackLock(); const pack = lock.packs.find(x => x.pack_id === id); if (!pack) throw new SezuError('pack_not_found', `pack not found: ${id}`); const state = await readJson(await packRecord(target, id), null); return { result: { ...pack, target, status: BASE_PACKS.has(id) && target === 'u' ? 'built-in' : (state?.state || 'not-installed'), installed_state: state } }; }, { mutating: false, family: 'pack' });
  runtime.register('sezu.pack.install', async function (args, target) {
    const id = required(args, 'pack_id', 'string');
    const lock = await loadPackLock();
    const pack = lock.packs.find(x => x.pack_id === id);
    if (!pack) throw new SezuError('pack_not_found', `pack not found: ${id}`);
    if (BASE_PACKS.has(id) && target === 'u') return { result: { pack_id: id, target, state: 'built-in', immutable: true } };
    const installed = [];
    const aptComponents = pack.components.filter(component => component.ecosystem === 'apt');
    const hostRepo = await fsp.mkdtemp(path.join(ROOTS.storage, `pack-repo-${id}-`));
    const targetRepo = `/tmp/sezu-pack-${id}-${uuid()}`;
    const sourceFile = `/tmp/sezu-pack-${id}-${uuid()}.list`;
    let installedPackages = [];
    try {
      if (aptComponents.length) {
        if (target === 'host') throw new SezuError('invalid_target', 'APT capability packs are defined for u or cell targets');
        await copyTargetToHost({ kind: 'target', target: 'u', path: '/cache/sezu/sources/apt/repo/Packages.gz' }, path.join(hostRepo, 'Packages.gz'), false);
        await call(this, 'sezu.file.mkdir', target, { path: targetRepo, parents: true });
        await copyHostToTarget(path.join(hostRepo, 'Packages.gz'), { kind: 'target', target, path: `${targetRepo}/Packages.gz` }, false);
        await call(this, 'sezu.file.write', target, { path: sourceFile, data: `deb [trusted=yes] file:${targetRepo} ./\n`, encoding: 'utf8', mode: 0o600 });
        const aptOptions = [
          '-o', `Dir::Etc::sourcelist=${sourceFile}`,
          '-o', 'Dir::Etc::sourceparts=-',
          '-o', 'APT::Get::List-Cleanup=0',
          '-o', 'Acquire::AllowInsecureRepositories=true'
        ];
        const selections = aptComponents.map(component => {
          const match = String(component.lock_ref).match(/package=([^;]+);architecture=(.+)/);
          if (!match) throw new SezuError('pack_lock_invalid', `invalid APT lock reference for ${component.component}`);
          return `${match[1]}=${component.version}`;
        });
        const packageList = async () => {
          const response = await call(this, 'sezu.exec', target, { argv: ['dpkg-query', '-W', '-f=${binary:Package}\\n'] });
          return new Set(response.stdout.split(/\r?\n/).filter(Boolean));
        };
        const before = await packageList();
        await call(this, 'sezu.exec', target, { argv: ['apt-get', '-qq', ...aptOptions, 'update'], env: { DEBIAN_FRONTEND: 'noninteractive' }, timeout_ms: args.timeout_ms || 300000 });
        const plan = await call(this, 'sezu.exec', target, { argv: ['apt-get', '-qq', ...aptOptions, '--download-only', '--print-uris', '-y', '--no-install-recommends', 'install', ...selections], env: { DEBIAN_FRONTEND: 'noninteractive' }, timeout_ms: args.timeout_ms || 300000 });
        const uris = plan.stdout.split(/\r?\n/).map(line => line.match(/^'([^']+)'/i)?.[1]).filter(Boolean);
        if (!uris.length) throw new SezuError('pack_dependency_plan_empty', `APT produced no locked dependency plan for ${id}`, { selections, stdout: plan.stdout, stderr: plan.stderr });
        const copied = new Set();
        for (const uri of uris) {
          const pathname = decodeURIComponent(new URL(uri).pathname);
          const relative = path.relative(targetRepo, pathname);
          if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new SezuError('pack_dependency_plan_invalid', `APT returned a path outside the pack repository: ${pathname}`);
          if (copied.has(relative)) continue;
          copied.add(relative);
          const hostFile = path.join(hostRepo, relative);
          await ensureDir(path.dirname(hostFile));
          await copyTargetToHost({ kind: 'target', target: 'u', path: `/cache/sezu/sources/apt/repo/${relative}` }, hostFile, false);
          await copyHostToTarget(hostFile, { kind: 'target', target, path: `${targetRepo}/${relative}` }, false);
        }
        await call(this, 'sezu.exec', target, { argv: ['apt-get', '-qq', ...aptOptions, 'install', '-y', '--no-install-recommends', ...selections], env: { DEBIAN_FRONTEND: 'noninteractive' }, timeout_ms: args.timeout_ms || 600000 });
        const after = await packageList();
        installedPackages = [...after].filter(name => !before.has(name)).sort();
        installed.push(...aptComponents);
      }
      for (const component of pack.components.filter(component => component.ecosystem !== 'apt')) {
        if (component.ecosystem === 'direct') {
          const script = `/tmp/sezu-install-locked-component-${uuid()}.sh`;
          try {
            await copyHostToTarget('/opt/sezu/current/scripts/install-locked-component.sh', { kind: 'target', target, path: script }, false);
            await call(this, 'sezu.file.chmod', target, { path: script, mode: 0o700 });
            await call(this, 'sezu.exec', target, { argv: [script, component.component, String(component.version), component.lock_ref], env: { SEZU_DIRECT_LOCK: '/opt/sezu/locks/0.1.0/direct-artifacts.tsv' }, timeout_ms: args.timeout_ms });
          } finally {
            try { await call(this, 'sezu.file.remove', target, { path: script }); } catch {}
          }
          installed.push(component);
        } else if (component.ecosystem === 'npm') {
          const root = args.install_root || `/opt/sezu/packs/${id}/node`;
          await call(this, 'sezu.exec', target, { argv: ['/bin/bash', '-lc', `mkdir -p "$1"; cd "$1"; npm install --offline --ignore-scripts --no-audit --no-fund "$2@$3"`, 'bash', root, component.component, String(component.version)], timeout_ms: args.timeout_ms });
          installed.push(component);
        } else if (component.ecosystem === 'python') {
          const root = args.install_root || `/opt/sezu/packs/${id}/venv`;
          await call(this, 'sezu.exec', target, { argv: ['/bin/bash', '-lc', `python3 -m venv "$1"; "$1/bin/pip" install --no-index --find-links /cache/sezu/sources/python "$2==$3"`, 'bash', root, component.component, String(component.version)], timeout_ms: args.timeout_ms });
          installed.push(component);
        } else throw new SezuError('pack_ecosystem_unsupported', `locked ecosystem is not installable by this release: ${component.ecosystem}`, { component });
      }
      const state = { pack_id: id, target, state: 'installed', installed_at: now(), components: installed, installed_packages: installedPackages };
      const file = await packRecord(target, id); await ensureDir(path.dirname(file)); await atomicJson(file, state);
      return { result: state };
    } finally {
      try { await call(this, 'sezu.file.remove', target, { path: sourceFile }); } catch {}
      try { await call(this, 'sezu.file.remove', target, { path: targetRepo, recursive: true }); } catch {}
      await fsp.rm(hostRepo, { recursive: true, force: true });
    }
  }, { family: 'pack' });
  runtime.register('sezu.pack.remove', async function (args, target) {
    const id = required(args, 'pack_id', 'string');
    if (BASE_PACKS.has(id) && target === 'u') throw new SezuError('immutable_builtin', 'base packs in the golden image are immutable');
    const file = await packRecord(target, id);
    const state = await readJson(file, null);
    if (!state) return { result: { pack_id: id, target, state: 'not-installed' } };
    const all = await this.handlers.get('sezu.pack.list').call(this, {}, target, { operation: 'sezu.pack.list' });
    const otherStates = (all.result.packs || []).filter(pack => pack.pack_id !== id && pack.status === 'installed').map(pack => pack.installed_state).filter(Boolean);
    const sharedPackages = new Set(otherStates.flatMap(record => record.installed_packages || []));
    const removablePackages = (state.installed_packages || []).filter(name => !sharedPackages.has(name));
    if (removablePackages.length) await call(this, 'sezu.exec', target, { argv: ['apt-get', '-qq', 'remove', '-y', ...removablePackages], env: { DEBIAN_FRONTEND: 'noninteractive' }, timeout_ms: args.timeout_ms || 600000 });
    await call(this, 'sezu.exec', target, { argv: ['rm', '-rf', `/opt/sezu/packs/${id}`] });
    await fsp.rm(file, { force: true });
    return { result: { pack_id: id, target, state: 'removed', removed_packages: removablePackages } };
  }, { family: 'pack' });

  runtime.register('sezu.browser.profile.list', async () => { await ensureDir(ROOTS.browser); const profiles = []; for (const e of await fsp.readdir(ROOTS.browser, { withFileTypes: true })) if (e.isDirectory() && !e.name.startsWith('.')) { const p = await readJson(path.join(ROOTS.browser, e.name, 'profile.json'), null); if (p) profiles.push(p); } return { result: { profiles } }; }, { mutating: false, family: 'browser' });
  runtime.register('sezu.browser.profile.create', async args => { const name = safeName(required(args, 'name', 'string'), 'profile name'); const p = profilePaths(name); if (await exists(p.metadata)) throw new SezuError('browser_profile_exists', `profile already exists: ${name}`); await ensureDir(p.data); await ensureDir(p.downloads); await ensureDir(p.staging); const record = { name, created_at: now(), workspace: args.workspace || null, settings: { locale: args.locale || 'en-US', timezone_id: args.timezone_id || 'America/New_York', viewport: args.viewport || { width: 1440, height: 900 }, geolocation: args.geolocation || null, permissions: args.permissions || [], user_agent: args.user_agent || null } }; await atomicJson(p.metadata, record); return { result: record }; }, { family: 'browser' });
  runtime.register('sezu.browser.profile.get', async args => ({ result: (await getProfile(required(args, 'name', 'string'))).record }), { mutating: false, family: 'browser' });
  runtime.register('sezu.browser.profile.export', async args => { const p = await getProfile(required(args, 'name', 'string')); const temp = path.join(ROOTS.storage, `browser-${p.record.name}-${uuid()}.tar`); await hostCommand(['tar', '-C', p.dir, '-cf', temp, '.']); const artifact = await artifactFromFile(temp, { name: `${p.record.name}.tar`, kind: 'browser-profile', profile: p.record.name }); if (args.path) await fsp.copyFile(temp, args.path); await fsp.rm(temp, { force: true }); return { artifacts: [artifact], result: { profile: p.record.name, artifact, path: args.path || null } }; }, { family: 'browser' });
  runtime.register('sezu.browser.profile.import', async args => { const name = safeName(required(args, 'name', 'string'), 'profile name'); const p = profilePaths(name); if (await exists(p.metadata) && !args.overwrite) throw new SezuError('browser_profile_exists', `profile already exists: ${name}`); await fsp.rm(p.dir, { recursive: true, force: true }); await ensureDir(p.dir); let source = args.path; if (args.artifact_id || args.artifact) source = artifactPath(args.artifact_id || args.artifact).file; if (!source) throw new SezuError('invalid_request', 'path or artifact_id is required'); await hostCommand(['tar', '-C', p.dir, '-xf', source]); const record = await readJson(p.metadata, null); if (!record) throw new SezuError('invalid_browser_profile', 'imported profile metadata is missing'); record.name = name; record.imported_at = now(); await atomicJson(p.metadata, record); return { result: record }; }, { family: 'browser' });
  runtime.register('sezu.browser.profile.delete', async args => { const p = await getProfile(required(args, 'name', 'string')); const sessions = await readJson(path.join(BROWSER_SESSIONS, `${p.record.name}.json`), null); if (sessions) throw new SezuError('browser_profile_open', 'close the browser profile session before deleting it'); await fsp.rm(p.dir, { recursive: true, force: true }); return { result: { deleted: p.record.name } }; }, { family: 'browser' });
  runtime.register('sezu.browser.open', async args => { const p = await getProfile(required(args, 'profile', 'string')); await ensureDir(BROWSER_SESSIONS); const id = args.session_id ? safeName(args.session_id, 'session_id') : uuid(); const session = { session_id: id, profile: p.record.name, created_at: now(), state: 'open', target: args.target || 'u' }; await atomicJson(path.join(BROWSER_SESSIONS, `${id}.json`), session); return { status: 'running', handle: id, result: session }; }, { family: 'browser' });
  runtime.register('sezu.browser.run', async function (args, defaultTarget) { const profileName = args.profile || (args.session_id ? (await readJson(path.join(BROWSER_SESSIONS, `${safeName(args.session_id, 'session_id')}.json`), null))?.profile : null); if (!profileName) throw new SezuError('invalid_request', 'profile or session_id is required'); const p = await getProfile(profileName); const target = args.target || (args.session_id ? (await readJson(path.join(BROWSER_SESSIONS, `${args.session_id}.json`), null))?.target : null) || defaultTarget; if (target === 'host') throw new SezuError('invalid_target', 'locked Playwright Chromium is installed in u and compatible cells, not on the host'); const instance = targetInstance(target); const remote = `/tmp/sezu-browser-${uuid()}`; await runIncusCli(['exec', instance, '--project', PROJECT, '--', 'mkdir', '-p', `${remote}/profile`, `${remote}/output`]); if (await exists(p.data)) await copyHostToTarget(p.data, { kind: 'target', target, path: `${remote}/profile` }, true); const requestFile = path.join(ROOTS.storage, `browser-request-${uuid()}.json`); await fsp.writeFile(requestFile, JSON.stringify({ profile: p.record, actions: args.actions || args.sequence || [], script: args.script || null, profile_dir: `${remote}/profile`, output_dir: `${remote}/output`, leave_open: false })); await runIncusCli(['file', 'push', requestFile, `${instance}${remote}/request.json`, '--project', PROJECT]); await runIncusCli(['file', 'push', '/opt/sezu/current/src/browser-worker.mjs', `${instance}${remote}/browser-worker.mjs`, '--project', PROJECT]); await fsp.rm(requestFile, { force: true }); const execResponse = await call(this, 'sezu.exec', target, { argv: ['/opt/sezu/toolchains/nodejs/24.19.0/node-v24.19.0-linux-x64/bin/node', `${remote}/browser-worker.mjs`, `${remote}/request.json`, `${remote}/result.json`], timeout_ms: args.timeout_ms || 300000 }); const resultTemp = path.join(ROOTS.storage, `browser-result-${uuid()}.json`); await runIncusCli(['file', 'pull', `${instance}${remote}/result.json`, resultTemp, '--project', PROJECT]); const result = await readJson(resultTemp); await fsp.rm(resultTemp, { force: true }); await fsp.rm(p.data, { recursive: true, force: true }); await copyTargetToHost({ kind: 'target', target, path: `${remote}/profile` }, p.data, true); const outputTemp = path.join(ROOTS.storage, `browser-output-${uuid()}`); await ensureDir(outputTemp); await copyTargetToHost({ kind: 'target', target, path: `${remote}/output` }, outputTemp, true).catch(() => {}); const artifacts = []; for (const file of await walkFiles(outputTemp)) artifacts.push(await artifactFromFile(file, { name: path.basename(file), kind: 'browser-output', profile: profileName })); await fsp.rm(outputTemp, { recursive: true, force: true }); await runIncusCli(['exec', instance, '--project', PROJECT, '--', 'rm', '-rf', remote]); p.record.last_used_at = now(); await atomicJson(p.metadata, p.record); return { artifacts, result: { ...result, execution: execResponse.result, artifacts } }; }, { family: 'browser' });
  runtime.register('sezu.browser.close', async args => { const id = safeName(required(args, 'session_id', 'string'), 'session_id'); const file = path.join(BROWSER_SESSIONS, `${id}.json`); const session = await readJson(file, null); if (!session) throw new SezuError('browser_session_not_found', `browser session not found: ${id}`); await fsp.rm(file, { force: true }); return { result: { ...session, state: 'closed', closed_at: now() } }; }, { family: 'browser' });
}

function mergeRanges(ranges) { ranges.sort((a, b) => a[0] - b[0]); const out = []; for (const r of ranges) { const last = out.at(-1); if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else out.push([...r]); } return out; }
function inferArchiveFormat(file) { const n = String(file).toLowerCase(); if (n.endsWith('.tar.gz') || n.endsWith('.tgz')) return 'tar.gz'; if (n.endsWith('.tar.xz')) return 'tar.xz'; if (n.endsWith('.tar')) return 'tar'; if (n.endsWith('.zip')) return 'zip'; if (n.endsWith('.7z')) return '7z'; if (n.endsWith('.cpio')) return 'cpio'; if (n.endsWith('.squashfs') || n.endsWith('.sqfs')) return 'squashfs'; throw new SezuError('invalid_request', 'archive format cannot be inferred; supply format'); }
async function walkFiles(root) { const out = []; if (!(await exists(root))) return out; for (const e of await fsp.readdir(root, { withFileTypes: true })) { const p = path.join(root, e.name); if (e.isDirectory()) out.push(...await walkFiles(p)); else if (e.isFile()) out.push(p); } return out; }
