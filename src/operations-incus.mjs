import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  ROOTS, PROJECT, INCUS_SOCKET, SezuError, artifactFromFile, artifactPath, asArray,
  asObject, asString, boundedInt, encodeData, incusJson, incusRequest, now,
  readJson, required, runIncusCli, runProcess, safeName, targetInstance, uuid
} from './util.mjs';

function esc(value) { return encodeURIComponent(String(value)); }
function project(args) { return args.project || PROJECT; }
function instanceName(args, target = null) {
  if (args.name) return safeName(args.name, 'instance name');
  if (args.instance) return safeName(args.instance, 'instance name');
  const fromTarget = targetInstance(target); if (fromTarget) return fromTarget;
  throw new SezuError('invalid_request', 'instance name is required');
}
function operationPath(value) {
  const op = String(value || ''); if (op.startsWith('/1.0/operations/')) return op; const id = op.replace(/^.*\//, ''); if (!id) throw new SezuError('invalid_request', 'operation is required'); return `/1.0/operations/${esc(id)}`;
}

async function hostCommand(argv, options = {}) {
  const result = await runProcess(argv, options); const stdout = await fsp.readFile(result.stdoutPath); const stderr = await fsp.readFile(result.stderrPath); await fsp.rm(result.tempDir, { recursive: true, force: true });
  if (result.code !== 0 || result.signal) throw new SezuError(options.code || 'command_failed', stderr.toString('utf8').trim() || `${argv[0]} failed`, { argv, exit_code: result.code, signal: result.signal, stdout: stdout.toString('utf8') });
  return { stdout, stderr };
}

async function waitOperation(op, timeoutMs = 60000) {
  const p = operationPath(op); const seconds = Math.ceil(boundedInt(timeoutMs, 'timeout_ms', 60000, 24 * 60 * 60 * 1000) / 1000);
  const response = await incusJson('GET', `${p}/wait`, { query: { timeout: seconds } }); const metadata = response.metadata || response;
  if (metadata.status_code >= 400 || metadata.err) throw new SezuError('incus_operation_failed', metadata.err || metadata.status || 'Incus operation failed', { operation: p, metadata });
  return metadata;
}

async function finish(response, args = {}) {
  const op = response.operation || response.metadata?.operation || null;
  if (!op || response.type === 'sync') return { status: 'completed', handle: op, result: response.metadata ?? response };
  if (args.wait === false) return { status: 'running', handle: op, result: { operation: op, response } };
  const metadata = await waitOperation(op, args.timeout_ms || 60000);
  return { status: metadata.status_code === 200 || metadata.status === 'Success' ? 'completed' : 'failed', handle: op, exit_code: metadata.metadata?.return ?? null, result: { operation: op, metadata } };
}

async function api(method, p, args = {}, body = undefined, options = {}) {
  const response = await incusJson(method, p, { project: options.global ? undefined : project(args), query: options.query || args.query, body });
  return options.raw ? response : await finish(response, args);
}

async function getObject(p, args = {}, global = false) { const response = await incusJson('GET', p, { project: global ? undefined : project(args), query: args.query }); return response.metadata ?? response; }

function sourceFromArgs(args, defaults = {}) {
  if (args.source && typeof args.source === 'object') return args.source;
  if (args.image || args.alias || args.fingerprint) return { type: 'image', alias: args.image || args.alias || args.fingerprint, mode: 'pull', protocol: args.protocol || 'simplestreams', server: args.server || undefined };
  if (defaults.golden) return { type: 'image', alias: 'sezu-u-golden-0.1.0' };
  throw new SezuError('configuration_required', 'an exact source object or image reference is required');
}

async function currentInstance(name, args) { return await getObject(`/1.0/instances/${esc(name)}`, args); }

async function setInstanceDevices(name, args, update) {
  const current = await currentInstance(name, args); const devices = { ...(current.devices || {}) }; update(devices);
  const body = { architecture: current.architecture, config: current.config || {}, devices, ephemeral: current.ephemeral || false, profiles: current.profiles || [], description: current.description || '' };
  return await api('PUT', `/1.0/instances/${esc(name)}`, args, body);
}

async function streamDownload(urlPath, output) {
  await hostCommand(['curl', '--fail', '--show-error', '--silent', '--unix-socket', INCUS_SOCKET, '--output', output, `http://localhost${urlPath}`]); return output;
}
async function streamUpload(method, urlPath, input, headers = []) {
  const argv = ['curl', '--fail-with-body', '--show-error', '--silent', '--unix-socket', INCUS_SOCKET, '-X', method, ...headers.flatMap(h => ['-H', h]), '--data-binary', `@${input}`, `http://localhost${urlPath}`]; const result = await hostCommand(argv); try { return JSON.parse(result.stdout.toString('utf8')); } catch (e) { throw new SezuError('incus_response_invalid', `Incus upload returned invalid JSON: ${e.message}`, { stdout: result.stdout.toString('utf8').slice(0, 4096) }); }
}

export function registerIncusOperations(runtime) {
  runtime.register('sezu.cell.list', async args => ({ result: { instances: await getObject('/1.0/instances', { ...args, query: { ...(args.query || {}), recursion: 2 } }) } }), { mutating: false, family: 'cell' });
  runtime.register('sezu.cell.status', async (args, target) => ({ result: await getObject(`/1.0/instances/${esc(instanceName(args, target))}/state`, args) }), { mutating: false, family: 'cell' });
  runtime.register('sezu.cell.create', async (args) => {
    const body = { name: safeName(required(args, 'name', 'string'), 'instance name'), type: args.type === 'virtual-machine' || args.type === 'vm' ? 'virtual-machine' : 'container', source: sourceFromArgs(args, { golden: args.use_golden === true }), profiles: args.profiles || [], config: args.config || {}, devices: args.devices || {}, ephemeral: args.ephemeral || false, description: args.description || '' };
    const result = await api('POST', '/1.0/instances', args, body); if (args.start && result.status === 'completed') await api('PUT', `/1.0/instances/${esc(body.name)}/state`, args, { action: 'start', timeout: args.start_timeout || 30, force: false, stateful: false }); return result;
  }, { family: 'cell' });
  const copyCell = async (args, refresh = false) => {
    const source = safeName(required(args, 'source', 'string'), 'source instance'); const name = safeName(required(args, 'name', 'string'), 'instance name');
    return await api('POST', '/1.0/instances', args, { name, type: args.type || 'container', source: { type: 'copy', source, project: args.source_project || project(args), refresh, instance_only: args.instance_only || false }, profiles: args.profiles, config: args.config, devices: args.devices });
  };
  runtime.register('sezu.cell.clone', async args => await copyCell(args, false), { family: 'cell' });
  runtime.register('sezu.cell.copy', async args => await copyCell(args, false), { family: 'cell' });
  runtime.register('sezu.cell.refresh', async args => await copyCell(args, true), { family: 'cell' });
  runtime.register('sezu.cell.rebuild', async args => await api('POST', `/1.0/instances/${esc(instanceName(args))}/rebuild`, args, { source: sourceFromArgs(args) }), { family: 'cell' });
  runtime.register('sezu.cell.rename', async args => await api('POST', `/1.0/instances/${esc(instanceName(args))}`, args, { name: safeName(required(args, 'new_name', 'string'), 'new instance name') }), { family: 'cell' });
  runtime.register('sezu.cell.move', async args => {
    const name = instanceName(args); if (!args.destination_project && !args.destination && !args.new_name) throw new SezuError('invalid_request', 'destination_project, destination, or new_name is required');
    const body = { name: args.new_name || name, project: args.destination_project, migration: Boolean(args.destination), live: args.live || false, instance_only: args.instance_only || false, target: args.destination };
    return await api('POST', `/1.0/instances/${esc(name)}`, args, body);
  }, { family: 'cell' });
  const state = action => async (args, target) => await api('PUT', `/1.0/instances/${esc(instanceName(args, target))}/state`, args, { action, timeout: args.action_timeout ?? 30, force: args.force || false, stateful: args.stateful || false });
  runtime.register('sezu.cell.start', state('start'), { family: 'cell' });
  runtime.register('sezu.cell.stop', state('stop'), { family: 'cell' });
  runtime.register('sezu.cell.restart', state('restart'), { family: 'cell' });
  runtime.register('sezu.cell.pause', state('freeze'), { family: 'cell' });
  runtime.register('sezu.cell.resume', state('unfreeze'), { family: 'cell' });
  runtime.register('sezu.cell.delete', async (args, target) => await api('DELETE', `/1.0/instances/${esc(instanceName(args, target))}`, args), { family: 'cell' });
  runtime.register('sezu.cell.console', async (args, target) => await api('POST', `/1.0/instances/${esc(instanceName(args, target))}/console`, { ...args, wait: false }, { width: args.cols || 120, height: args.rows || 40, type: args.console_type || 'console' }), { family: 'cell' });
  runtime.register('sezu.cell.exec', async (args, target) => {
    const name = instanceName(args, target); const command = args.argv || args.command; if (!Array.isArray(command) || !command.length) throw new SezuError('invalid_request', 'argv array is required');
    const body = { command: command.map(String), 'wait-for-websocket': false, 'record-output': true, interactive: false, environment: args.env || {}, 'user': args.user || 0, 'group': args.group || 0, cwd: args.cwd || '/' };
    return await api('POST', `/1.0/instances/${esc(name)}/exec`, args, body);
  }, { family: 'cell' });
  runtime.register('sezu.cell.file.push', async (args, target) => {
    const name = instanceName(args, target); const remotePath = required(args, 'path', 'string'); let body;
    if (args.artifact_id || args.artifact) body = await fsp.readFile(artifactPath(args.artifact_id || args.artifact).file);
    else if (args.source_path) body = await fsp.readFile(args.source_path);
    else if (typeof args.data === 'string') body = Buffer.from(args.data, args.encoding || 'base64');
    else throw new SezuError('invalid_request', 'data, source_path, or artifact_id is required');
    const headers = { 'X-Incus-type': args.type || 'file', 'X-Incus-mode': typeof args.mode === 'number' ? args.mode.toString(8) : String(args.mode || '0640'), 'X-Incus-uid': String(args.uid ?? 0), 'X-Incus-gid': String(args.gid ?? 0), 'X-Incus-write': args.write || 'overwrite' };
    const response = await incusRequest('POST', `/1.0/instances/${esc(name)}/files`, { project: project(args), query: { path: remotePath }, body, headers }); return { result: { status_code: response.status_code, path: remotePath, bytes: body.length } };
  }, { family: 'cell' });
  runtime.register('sezu.cell.file.pull', async (args, target) => {
    const name = instanceName(args, target); const remotePath = required(args, 'path', 'string'); const response = await incusRequest('GET', `/1.0/instances/${esc(name)}/files`, { project: project(args), query: { path: remotePath } });
    if (args.destination) { await fsp.writeFile(args.destination, response.body); return { result: { path: remotePath, destination: args.destination, bytes: response.body.length, headers: response.headers } }; }
    if (response.body.length > 64 * 1024) { const temp = path.join(ROOTS.storage, `cell-file-${uuid()}`); await fsp.writeFile(temp, response.body); const artifact = await artifactFromFile(temp, { name: path.basename(remotePath), source: `${name}:${remotePath}` }); await fsp.rm(temp, { force: true }); return { artifacts: [artifact], result: { artifact, bytes: response.body.length, headers: response.headers } }; }
    return { result: { data: encodeData(response.body, args.encoding || 'base64'), encoding: args.encoding || 'base64', bytes: response.body.length, headers: response.headers } };
  }, { mutating: false, family: 'cell' });
  runtime.register('sezu.cell.backup.export', async (args, target) => {
    const name = instanceName(args, target); const backup = args.backup_name || `sezu-${Date.now()}`; const created = await api('POST', `/1.0/instances/${esc(name)}/backups`, args, { name: backup, instance_only: args.instance_only || false, optimized_storage: args.optimized_storage || false, compression_algorithm: args.compression_algorithm || 'gzip', expires_at: args.expires_at || new Date(0).toISOString() });
    const temp = path.join(ROOTS.storage, `${name}-${backup}.tar`); await streamDownload(`/1.0/instances/${esc(name)}/backups/${esc(backup)}/export?project=${esc(project(args))}`, temp); const artifact = await artifactFromFile(temp, { name: `${name}-${backup}.tar`, kind: 'incus-instance-backup', instance: name, backup }); if (args.path) await fsp.copyFile(temp, args.path); await fsp.rm(temp, { force: true }); if (args.delete_backup !== false) await api('DELETE', `/1.0/instances/${esc(name)}/backups/${esc(backup)}`, args); return { artifacts: [artifact], result: { create: created.result, artifact, path: args.path || null } };
  }, { family: 'cell' });
  runtime.register('sezu.cell.backup.import', async args => {
    let file = args.path; if (args.artifact_id || args.artifact) file = artifactPath(args.artifact_id || args.artifact).file; if (!file) throw new SezuError('invalid_request', 'path or artifact_id is required'); const query = new URLSearchParams({ project: project(args) }); if (args.name) query.set('name', args.name); const response = await streamUpload('POST', `/1.0/instances?${query}`, file, ['Content-Type: application/octet-stream']); return await finish(response, args);
  }, { family: 'cell' });
  runtime.register('sezu.cell.migrate', async (args, target) => {
    const name = instanceName(args, target); const body = args.body || { migration: true, live: args.live || false, instance_only: args.instance_only || false, target: required(args, 'target_server', 'string'), project: args.destination_project, name: args.destination_name || name };
    return await api('POST', `/1.0/instances/${esc(name)}`, { ...args, wait: args.wait ?? false }, body);
  }, { family: 'cell' });

  runtime.register('sezu.incus.request', async args => {
    const method = String(required(args, 'method', 'string')).toUpperCase(); const p = required(args, 'path', 'string'); let body = args.body;
    if (args.artifact_id || args.artifact) body = await fsp.readFile(artifactPath(args.artifact_id || args.artifact).file);
    else if (typeof args.body_base64 === 'string') body = Buffer.from(args.body_base64, 'base64');
    const response = await incusRequest(method, p, { project: args.project, query: args.query, body, headers: args.headers });
    if (response.json) return { status: response.json.type === 'async' ? 'running' : 'completed', handle: response.json.operation || null, result: response.json };
    if (response.body.length > 64 * 1024) { const temp = path.join(ROOTS.storage, `incus-response-${uuid()}`); await fsp.writeFile(temp, response.body); const artifact = await artifactFromFile(temp, { name: 'incus-response.bin', path: p }); await fsp.rm(temp, { force: true }); return { artifacts: [artifact], result: { status_code: response.status_code, headers: response.headers, artifact } }; }
    return { result: { status_code: response.status_code, headers: response.headers, body_base64: response.body.toString('base64') } };
  }, { family: 'incus' });
  runtime.register('sezu.incus.operation.wait', async args => { const p = operationPath(required(args, 'operation', 'string')); const result = await waitOperation(p, args.timeout_ms || 60000); return { status: result.status_code === 200 || result.status === 'Success' ? 'completed' : 'failed', handle: p, result }; }, { mutating: false, family: 'incus' });
  runtime.register('sezu.incus.operation.cancel', async args => { const p = operationPath(required(args, 'operation', 'string')); const response = await incusJson('DELETE', p); return { status: 'cancelled', handle: p, result: response.metadata ?? response }; }, { family: 'incus' });

  registerCrud(runtime, 'project', '/1.0/projects', { global: true, body: args => ({ name: safeName(required(args, 'name', 'string'), 'project name'), description: args.description || '', config: args.config || {} }) });
  registerCrud(runtime, 'profile', '/1.0/profiles', { body: args => ({ name: safeName(required(args, 'name', 'string'), 'profile name'), description: args.description || '', config: args.config || {}, devices: args.devices || {} }), extra: true });
  runtime.register('sezu.profile.apply', async args => {
    const name = instanceName(args); const current = await currentInstance(name, args); const profileName = safeName(required(args, 'profile', 'string'), 'profile name'); let profiles = [...(current.profiles || [])]; if (args.remove) profiles = profiles.filter(x => x !== profileName); else if (!profiles.includes(profileName)) profiles.push(profileName); const body = { architecture: current.architecture, config: current.config || {}, devices: current.devices || {}, ephemeral: current.ephemeral || false, profiles, description: current.description || '' }; return await api('PUT', `/1.0/instances/${esc(name)}`, args, body);
  }, { family: 'profile' });

  runtime.register('sezu.remote.list', async () => { const result = await runIncusCli(['remote', 'list', '--format', 'json']); return { result: JSON.parse(result.stdout.toString('utf8')) }; }, { mutating: false, family: 'remote' });
  runtime.register('sezu.remote.add', async args => { const argv = ['remote', 'add', safeName(required(args, 'name', 'string'), 'remote name'), required(args, 'url', 'string')]; if (args.protocol) argv.push('--protocol', args.protocol); if (args.public) argv.push('--public'); if (args.accept_certificate) argv.push('--accept-certificate'); if (args.token) argv.push('--token', args.token); await runIncusCli(argv); return { result: { added: args.name, url: args.url } }; }, { family: 'remote' });
  runtime.register('sezu.remote.update', async args => { const name = safeName(required(args, 'name', 'string'), 'remote name'); if (args.url) await runIncusCli(['remote', 'set-url', name, args.url]); for (const [k, v] of Object.entries(args.config || {})) await runIncusCli(['remote', 'set', name, k, String(v)]); return { result: { updated: name } }; }, { family: 'remote' });
  runtime.register('sezu.remote.remove', async args => { await runIncusCli(['remote', 'remove', safeName(required(args, 'name', 'string'), 'remote name')]); return { result: { removed: args.name } }; }, { family: 'remote' });

  runtime.register('sezu.certificate.list', async args => ({ result: { certificates: await getObject('/1.0/certificates', { ...args, query: { ...(args.query || {}), recursion: 2 } }, true) } }), { mutating: false, family: 'certificate' });
  runtime.register('sezu.certificate.add', async args => await api('POST', '/1.0/certificates', args, { name: args.name || '', type: args.type || 'client', certificate: required(args, 'certificate', 'string'), restricted: args.restricted || false, projects: args.projects || [] }, { global: true }), { family: 'certificate' });
  runtime.register('sezu.certificate.token', async args => await api('POST', '/1.0/certificates', { ...args, wait: false }, { name: args.name || '', type: 'client', token: true, restricted: args.restricted || false, projects: args.projects || [] }, { global: true }), { family: 'certificate' });
  runtime.register('sezu.certificate.remove', async args => await api('DELETE', `/1.0/certificates/${esc(required(args, 'fingerprint', 'string'))}`, args, undefined, { global: true }), { family: 'certificate' });

  registerCrud(runtime, 'storage.pool', '/1.0/storage-pools', { global: true, body: args => ({ name: safeName(required(args, 'name', 'string'), 'pool name'), driver: required(args, 'driver', 'string'), description: args.description || '', config: args.config || {} }) });

  runtime.register('sezu.volume.list', async args => { const pool = safeName(required(args, 'pool', 'string'), 'pool name'); return { result: { volumes: await getObject(`/1.0/storage-pools/${esc(pool)}/volumes/custom`, { ...args, query: { ...(args.query || {}), recursion: 2 } }) } }; }, { mutating: false, family: 'volume' });
  runtime.register('sezu.volume.create', async args => { const pool = safeName(required(args, 'pool', 'string'), 'pool name'); return await api('POST', `/1.0/storage-pools/${esc(pool)}/volumes/custom`, args, { name: safeName(required(args, 'name', 'string'), 'volume name'), description: args.description || '', config: args.config || {}, content_type: args.content_type || 'filesystem' }); }, { family: 'volume' });
  runtime.register('sezu.volume.attach', async args => { const name = instanceName(args); const device = safeName(args.device || args.volume, 'device name'); const pool = safeName(required(args, 'pool', 'string'), 'pool name'); const volume = safeName(required(args, 'volume', 'string'), 'volume name'); return await setInstanceDevices(name, args, devices => { devices[device] = { type: 'disk', pool, source: volume, path: required(args, 'path', 'string'), ...(args.device_config || {}) }; }); }, { family: 'volume' });
  runtime.register('sezu.volume.detach', async args => { const name = instanceName(args); const device = safeName(required(args, 'device', 'string'), 'device name'); return await setInstanceDevices(name, args, devices => { if (!devices[device]) throw new SezuError('device_not_found', `device not found: ${device}`); delete devices[device]; }); }, { family: 'volume' });
  const copyVolume = move => async args => { const pool = safeName(required(args, 'pool', 'string'), 'pool name'); const name = safeName(required(args, 'name', 'string'), 'volume name'); const source = { type: 'copy', name: safeName(required(args, 'source', 'string'), 'source volume'), pool: args.source_pool || pool, project: args.source_project || project(args), volume_only: args.volume_only || false, refresh: args.refresh || false }; const result = await api('POST', `/1.0/storage-pools/${esc(pool)}/volumes/custom`, args, { name, source }); if (move) { await finish(await incusJson('DELETE', `/1.0/storage-pools/${esc(args.source_pool || pool)}/volumes/custom/${esc(source.name)}`, { project: args.source_project || project(args) }), args); } return result; };
  runtime.register('sezu.volume.copy', copyVolume(false), { family: 'volume' });
  runtime.register('sezu.volume.move', copyVolume(true), { family: 'volume' });
  runtime.register('sezu.volume.backup.export', async args => { const pool = safeName(required(args, 'pool', 'string'), 'pool name'); const name = safeName(required(args, 'name', 'string'), 'volume name'); const backup = args.backup_name || `sezu-${Date.now()}`; await api('POST', `/1.0/storage-pools/${esc(pool)}/volumes/custom/${esc(name)}/backups`, args, { name: backup, expires_at: args.expires_at || new Date(0).toISOString(), optimized_storage: args.optimized_storage || false }); const temp = path.join(ROOTS.storage, `${pool}-${name}-${backup}.tar`); await streamDownload(`/1.0/storage-pools/${esc(pool)}/volumes/custom/${esc(name)}/backups/${esc(backup)}/export?project=${esc(project(args))}`, temp); const artifact = await artifactFromFile(temp, { name: `${pool}-${name}-${backup}.tar`, kind: 'incus-volume-backup', pool, volume: name }); if (args.path) await fsp.copyFile(temp, args.path); await fsp.rm(temp, { force: true }); if (args.delete_backup !== false) await api('DELETE', `/1.0/storage-pools/${esc(pool)}/volumes/custom/${esc(name)}/backups/${esc(backup)}`, args); return { artifacts: [artifact], result: { artifact, path: args.path || null } }; }, { family: 'volume' });
  runtime.register('sezu.volume.backup.import', async args => {
    const pool = safeName(required(args, 'pool', 'string'), 'pool name');
    let file = args.path; if (args.artifact_id || args.artifact) file = artifactPath(args.artifact_id || args.artifact).file;
    if (!file) throw new SezuError('invalid_request', 'path or artifact_id is required');
    const query = new URLSearchParams({ project: project(args) });
    const response = await streamUpload('POST', `/1.0/storage-pools/${esc(pool)}/volumes/custom?${query}`, file, ['Content-Type: application/octet-stream']);
    const imported = await finish(response, args);
    const resource = imported.result?.metadata?.resources?.storage_volumes?.[0] || imported.result?.resources?.storage_volumes?.[0] || null;
    const importedName = resource ? decodeURIComponent(new URL(resource, 'http://incus.local').pathname.split('/').at(-1)) : null;
    let renamed = null;
    if (args.name && importedName && args.name !== importedName) {
      renamed = await api('POST', `/1.0/storage-pools/${esc(pool)}/volumes/custom/${esc(importedName)}`, args, { name: safeName(args.name, 'volume name'), migration: false, pool, volume_only: false });
    }
    return { status: renamed?.status || imported.status, handle: renamed?.handle || imported.handle, result: { imported: imported.result, original_name: importedName, name: args.name || importedName, renamed: renamed?.result || null } };
  }, { family: 'volume' });
  runtime.register('sezu.volume.delete', async args => await api('DELETE', `/1.0/storage-pools/${esc(safeName(required(args, 'pool', 'string'), 'pool name'))}/volumes/custom/${esc(safeName(required(args, 'name', 'string'), 'volume name'))}`, args), { family: 'volume' });

  registerCrud(runtime, 'network', '/1.0/networks', { body: args => ({ name: safeName(required(args, 'name', 'string'), 'network name'), type: args.type || 'bridge', description: args.description || '', config: args.config || {}, managed: true }) });
  registerNestedCrud(runtime, 'network.forward', args => `/1.0/networks/${esc(safeName(required(args, 'network', 'string'), 'network name'))}/forwards`, { body: args => ({ listen_address: required(args, 'listen_address', 'string'), description: args.description || '', config: args.config || {}, ports: args.ports || [] }), key: 'listen_address' });
  runtime.register('sezu.network.zone.list', async args => ({ result: { items: await getObject('/1.0/network-zones', { ...args, query: { ...(args.query || {}), recursion: 2 } }) } }), { mutating: false, family: 'network' });
  runtime.register('sezu.network.zone.create', async args => await api('POST', '/1.0/network-zones', args, { name: safeName(required(args, 'name', 'string'), 'zone name'), description: args.description || '', config: args.config || {} }), { family: 'network' });
  runtime.register('sezu.network.zone.delete', async args => await api('DELETE', `/1.0/network-zones/${esc(safeName(required(args, 'name', 'string'), 'zone name'))}`, args), { family: 'network' });
  runtime.register('sezu.network.zone.record.set', async args => { const zone = safeName(required(args, 'zone', 'string'), 'zone name'); const name = safeName(required(args, 'name', 'string'), 'record name'); const body = { name, description: args.description || '', config: args.config || {}, entries: args.entries || [] }; const current = await incusJson('GET', `/1.0/network-zones/${esc(zone)}/records/${esc(name)}`, { project: project(args) }).catch(e => e.code === 'incus_error' && e.details?.status_code === 404 ? null : Promise.reject(e)); return await api(current ? 'PUT' : 'POST', current ? `/1.0/network-zones/${esc(zone)}/records/${esc(name)}` : `/1.0/network-zones/${esc(zone)}/records`, args, body); }, { family: 'network' });
  runtime.register('sezu.network.zone.record.delete', async args => await api('DELETE', `/1.0/network-zones/${esc(safeName(required(args, 'zone', 'string'), 'zone name'))}/records/${esc(safeName(required(args, 'name', 'string'), 'record name'))}`, args), { family: 'network' });

  runtime.register('sezu.device.list', async args => { const current = await currentInstance(instanceName(args), args); return { result: { instance: current.name, devices: current.devices || {}, expanded_devices: current.expanded_devices || {} } }; }, { mutating: false, family: 'device' });
  runtime.register('sezu.device.attach', async args => { const name = instanceName(args); const device = safeName(required(args, 'device', 'string'), 'device name'); const config = asObject(required(args, 'config'), 'config'); return await setInstanceDevices(name, args, devices => { if (devices[device] && !args.replace) throw new SezuError('device_exists', `device already exists: ${device}`); devices[device] = config; }); }, { family: 'device' });
  runtime.register('sezu.device.update', async args => { const name = instanceName(args); const device = safeName(required(args, 'device', 'string'), 'device name'); const config = asObject(required(args, 'config'), 'config'); return await setInstanceDevices(name, args, devices => { if (!devices[device]) throw new SezuError('device_not_found', `device not found: ${device}`); devices[device] = { ...devices[device], ...config }; }); }, { family: 'device' });
  runtime.register('sezu.device.detach', async args => { const name = instanceName(args); const device = safeName(required(args, 'device', 'string'), 'device name'); return await setInstanceDevices(name, args, devices => { if (!devices[device]) throw new SezuError('device_not_found', `device not found: ${device}`); delete devices[device]; }); }, { family: 'device' });

  runtime.register('sezu.image.list', async args => ({ result: { images: await getObject('/1.0/images', { ...args, query: { ...(args.query || {}), recursion: 2 } }) } }), { mutating: false, family: 'image' });
  runtime.register('sezu.image.import', async args => { let file = args.path; if (args.artifact_id || args.artifact) file = artifactPath(args.artifact_id || args.artifact).file; if (!file) throw new SezuError('invalid_request', 'path or artifact_id is required'); const query = new URLSearchParams({ project: project(args) }); if (args.alias) query.set('alias', args.alias); const response = await streamUpload('POST', `/1.0/images?${query}`, file, ['Content-Type: application/octet-stream']); return await finish(response, args); }, { family: 'image' });
  runtime.register('sezu.image.build', async args => { if (args.instance) return await api('POST', '/1.0/images', args, { source: { type: 'container', name: args.instance }, aliases: args.aliases || [], properties: args.properties || {}, compression_algorithm: args.compression_algorithm || 'gzip', filename: args.filename, public: args.public || false }); if (args.path || args.artifact_id) return await runtime.handlers.get('sezu.image.import').call(runtime, args, 'host', { operation: 'sezu.image.import' }); throw new SezuError('configuration_required', 'image build requires instance, path, or artifact_id'); }, { family: 'image' });
  runtime.register('sezu.image.status', async args => ({ result: await getObject(`/1.0/images/${esc(required(args, 'fingerprint', 'string'))}`, args) }), { mutating: false, family: 'image' });
  runtime.register('sezu.image.publish', async args => await api('POST', '/1.0/images', args, { source: { type: args.type || 'container', name: required(args, 'instance', 'string') }, aliases: args.aliases || (args.alias ? [{ name: args.alias }] : []), properties: args.properties || {}, compression_algorithm: args.compression_algorithm || 'gzip', public: args.public || false }), { family: 'image' });
  runtime.register('sezu.image.copy', async args => await api('POST', '/1.0/images', args, { source: { type: 'image', fingerprint: required(args, 'fingerprint', 'string'), server: args.server, protocol: args.protocol, certificate: args.certificate, alias: args.alias }, aliases: args.aliases || [], copy_aliases: args.copy_aliases || false, auto_update: args.auto_update || false, public: args.public || false }), { family: 'image' });
  runtime.register('sezu.image.launch', async args => await runtime.handlers.get('sezu.cell.create').call(runtime, { ...args, source: { type: 'image', alias: args.image || args.alias || required(args, 'fingerprint', 'string') } }, 'host', { operation: 'sezu.cell.create' }), { family: 'image' });
  runtime.register('sezu.image.delete', async args => await api('DELETE', `/1.0/images/${esc(required(args, 'fingerprint', 'string'))}`, args), { family: 'image' });

  runtime.register('sezu.snapshot.create', async args => { const name = instanceName(args); return await api('POST', `/1.0/instances/${esc(name)}/snapshots`, args, { name: safeName(required(args, 'snapshot', 'string'), 'snapshot name'), stateful: args.stateful || false, expires_at: args.expires_at || new Date(0).toISOString() }); }, { family: 'snapshot' });
  runtime.register('sezu.snapshot.list', async args => { const name = instanceName(args); return { result: { snapshots: await getObject(`/1.0/instances/${esc(name)}/snapshots`, { ...args, query: { ...(args.query || {}), recursion: 2 } }) } }; }, { mutating: false, family: 'snapshot' });
  runtime.register('sezu.snapshot.restore', async args => { const name = instanceName(args); const current = await currentInstance(name, args); const body = { architecture: current.architecture, config: current.config || {}, devices: current.devices || {}, ephemeral: current.ephemeral || false, profiles: current.profiles || [], description: current.description || '', restore: safeName(required(args, 'snapshot', 'string'), 'snapshot name'), stateful: args.stateful || false }; return await api('PUT', `/1.0/instances/${esc(name)}`, args, body); }, { family: 'snapshot' });
  runtime.register('sezu.snapshot.copy', async args => { const sourceInstance = safeName(required(args, 'source_instance', 'string'), 'source instance'); const snapshot = safeName(required(args, 'snapshot', 'string'), 'snapshot name'); const destination = safeName(required(args, 'name', 'string'), 'instance name'); return await api('POST', '/1.0/instances', args, { name: destination, type: args.type || 'container', source: { type: 'copy', source: `${sourceInstance}/${snapshot}`, project: args.source_project || project(args), instance_only: true }, profiles: args.profiles, config: args.config, devices: args.devices }); }, { family: 'snapshot' });
  runtime.register('sezu.snapshot.delete', async args => await api('DELETE', `/1.0/instances/${esc(instanceName(args))}/snapshots/${esc(safeName(required(args, 'snapshot', 'string'), 'snapshot name'))}`, args), { family: 'snapshot' });
}

function registerCrud(runtime, prefix, base, options = {}) {
  const family = prefix.split('.')[0]; const item = args => `${base}/${esc(safeName(required(args, 'name', 'string'), `${family} name`))}`;
  runtime.register(`sezu.${prefix}.list`, async args => ({ result: { items: await getObject(base, { ...args, query: { ...(args.query || {}), recursion: 2 } }, options.global) } }), { mutating: false, family });
  runtime.register(`sezu.${prefix}.create`, async args => await api('POST', base, args, options.body(args), { global: options.global }), { family });
  runtime.register(`sezu.${prefix}.update`, async args => { const current = await getObject(item(args), args, options.global); const body = { ...current, ...asObject(required(args, 'values'), 'values') }; delete body.name; delete body.used_by; delete body.locations; delete body.status; return await api('PUT', item(args), args, body, { global: options.global }); }, { family });
  runtime.register(`sezu.${prefix}.delete`, async args => await api('DELETE', item(args), args, undefined, { global: options.global }), { family });
}
function registerNestedCrud(runtime, prefix, baseFn, options = {}) {
  const family = prefix.split('.')[0]; const key = options.key || 'name'; const item = args => `${baseFn(args)}/${esc(required(args, key, 'string'))}`;
  runtime.register(`sezu.${prefix}.list`, async args => ({ result: { items: await getObject(baseFn(args), { ...args, query: { ...(args.query || {}), recursion: 2 } }) } }), { mutating: false, family });
  runtime.register(`sezu.${prefix}.create`, async args => await api('POST', baseFn(args), args, options.body(args)), { family });
  runtime.register(`sezu.${prefix}.update`, async args => { const current = await getObject(item(args), args); const body = { ...current, ...asObject(required(args, 'values'), 'values') }; delete body.used_by; delete body.location; return await api('PUT', item(args), args, body); }, { family });
  runtime.register(`sezu.${prefix}.delete`, async args => await api('DELETE', item(args), args), { family });
}
