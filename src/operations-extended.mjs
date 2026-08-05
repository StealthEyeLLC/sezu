import fsp from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import {
  ROOTS, SezuError, artifactFromFile, artifactPath, asArray, asObject,
  atomicJson, ensureDir, exists, now, readJson, required, runProcess, safeName, uuid
} from './util.mjs';

const SYSTEMD = '/etc/systemd/system';

async function call(runtime, operation, target, args) {
  const response = await runtime.dispatch({ operation, target, args, request_id: uuid() });
  if (!response.ok) throw new SezuError(response.error?.code || 'operation_failed', response.error?.message || `${operation} failed`, response.error?.details);
  return response;
}

async function hostCommand(argv, options = {}) {
  const result = await runProcess(argv, options); const stdout = await fsp.readFile(result.stdoutPath); const stderr = await fsp.readFile(result.stderrPath); await fsp.rm(result.tempDir, { recursive: true, force: true });
  if (result.code !== 0 || result.signal) throw new SezuError(options.code || 'command_failed', stderr.toString('utf8').trim() || `${argv[0]} failed`, { argv, exit_code: result.code, signal: result.signal, stdout: stdout.toString('utf8') });
  return { stdout, stderr };
}

async function parseFile(file) { const text = await fsp.readFile(file, 'utf8'); return /\.ya?ml$/.test(file) ? YAML.parse(text) : JSON.parse(text); }

async function templateCatalog() {
  const roots = [
    { root: '/opt/sezu/current/templates', scope: 'builtin' },
    { root: ROOTS.templates, scope: 'owner' }
  ];
  const out = [];
  for (const source of roots) {
    if (!(await exists(source.root))) continue;
    for (const kind of ['tasks', 'services', 'vms']) {
      const dir = path.join(source.root, kind); if (!(await exists(dir))) continue;
      for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !/\.(json|ya?ml)$/.test(entry.name)) continue;
        const file = path.join(dir, entry.name); const value = await parseFile(file);
        out.push({ ...value, template_id: value.template_id || path.parse(entry.name).name, kind: kind.slice(0, -1), scope: source.scope, file });
      }
    }
  }
  return out;
}

async function getTemplate(id) {
  const found = (await templateCatalog()).find(x => x.template_id === id); if (!found) throw new SezuError('template_not_found', `template not found: ${id}`); return found;
}

export function serviceDockerRunArguments({ reference, environment = {}, volumes = [], ports = [], command = [], dockerArgs = [], containerName = 'sezu-service' }) {
  const argv = ['docker', 'run', '--detach', '--name', containerName, '--restart', 'unless-stopped'];
  for (const [name, value] of Object.entries(environment)) argv.push('--env', `${name}=${value}`);
  for (const port of ports) argv.push('--publish', `${port}:${port}`);
  for (const volume of volumes) if (volume?.path) argv.push('--volume', `${volume.path}:${volume.path}`);
  argv.push(...dockerArgs.map(String), reference, ...command.map(String));
  return argv;
}

function timerPaths(name) {
  safeName(name, 'timer name'); const stem = `sezu-timer-${name}`;
  return { stem, service: path.join(SYSTEMD, `${stem}.service`), timer: path.join(SYSTEMD, `${stem}.timer`), request: path.join(ROOTS.timers, `${name}.request.json`), metadata: path.join(ROOTS.timers, `${name}.json`) };
}

function timerRequest(args) {
  if (args.operation) return { operation: args.operation, target: args.target, args: args.args || {} };
  if (args.macro) return { operation: 'sezu.macro.run', target: args.target, args: { name: args.macro, inputs: args.inputs || {} } };
  if (args.skill) return { operation: 'sezu.skill.run', target: args.target, args: { name: args.skill, input: args.input || {} } };
  if (args.argv || args.command) return { operation: 'sezu.exec', target: args.target, args: { argv: args.argv, command: args.command, cwd: args.cwd, env: args.env || {} } };
  throw new SezuError('invalid_request', 'timer requires operation, macro, skill, argv, or command');
}

async function backupSources(args) {
  const sources = [];
  for (const item of args.resources || []) {
    if (typeof item === 'string') {
      if (item === 'state') sources.push('/var/lib/sezu');
      else if (item === 'configuration') sources.push('/etc/sezu');
      else if (item === 'artifacts') sources.push(ROOTS.artifacts);
      else if (item === 'workspaces') sources.push(ROOTS.workspaces);
      else sources.push(item);
    } else if (item.path) sources.push(item.path);
  }
  if (args.paths) sources.push(...asArray(args.paths, 'paths'));
  if (!sources.length) throw new SezuError('invalid_request', 'backup requires at least one filesystem resource, path, instance, or volume');
  return [...new Set(sources.map(String))];
}

export function registerExtendedOperations(runtime) {
  runtime.register('sezu.template.list', async args => {
    let templates = await templateCatalog(); if (args.kind) templates = templates.filter(x => x.kind === args.kind); return { result: { templates, count: templates.length } };
  }, { mutating: false, family: 'template' });
  runtime.register('sezu.template.inspect', async args => ({ result: await getTemplate(required(args, 'template_id', 'string')) }), { mutating: false, family: 'template' });
  runtime.register('sezu.template.launch', async function (args, defaultTarget) {
    const template = await getTemplate(required(args, 'template_id', 'string')); const name = safeName(required(args, 'name', 'string'), 'instance name'); const project = args.project || template.project || 'sezu';
    let createArgs;
    if (template.kind === 'task') {
      const sourceRef = args.source || template.source?.reference || 'sezu-u-golden-0.1.0';
      createArgs = { name, project, type: template.instance_type || 'container', source: { type: 'image', alias: sourceRef }, profiles: args.profiles || template.profiles || [], config: { ...(template.config || {}), ...(args.config || {}) }, devices: { ...(template.devices || {}), ...(args.devices || {}) }, start: args.start !== false };
    } else if (template.kind === 'service') {
      const reference = args.image || template.image?.reference || template.image_reference || template.immutable_reference || template.source?.reference;
      if (!reference) throw new SezuError('configuration_required', 'service template has no immutable image reference and no image override was supplied');
      if (!String(reference).includes('@sha256:')) throw new SezuError('configuration_required', 'service image reference must include an immutable sha256 digest');
      const envNames = template.required_environment || template.environment_names || template.environment?.required || [];
      const env = asObject(args.environment || args.env || {}, 'environment'); const missing = envNames.filter(k => !(k in env)); if (missing.length) throw new SezuError('configuration_required', `missing required service environment values: ${missing.join(', ')}`);
      createArgs = { name, project, type: template.instance_type || 'container', source: args.source || { type: 'image', alias: args.base_image || 'sezu-u-golden-0.1.0' }, profiles: args.profiles || template.profiles || ['sezu-u-power'], config: { ...(template.config || {}), ...(args.config || {}) }, devices: { ...(template.devices || {}), ...(args.devices || {}) }, start: false };
    } else if (template.kind === 'vm') {
      const source = args.source || template.source; if (!source?.reference && !source?.alias && !source?.fingerprint) throw new SezuError('configuration_required', 'VM template launch requires an exact image or disk source');
      createArgs = { name, project, type: 'virtual-machine', source: source.type ? source : { type: 'image', alias: source.reference || source.alias || source.fingerprint }, profiles: args.profiles || template.profiles || [], config: { ...(template.config || {}), ...(args.config || {}) }, devices: { ...(template.devices || {}), ...(args.devices || {}) }, start: args.start ?? template.start ?? false };
    } else throw new SezuError('invalid_template', `unsupported template kind: ${template.kind}`);
    const launched = await call(this, 'sezu.cell.create', defaultTarget, createArgs);
    const volumes = args.volumes || [];
    for (const volume of volumes) await call(this, 'sezu.volume.attach', defaultTarget, { project, instance: name, ...volume });
    let service = null;
    if (template.kind === 'service' && args.start !== false) {
      await call(this, 'sezu.cell.start', defaultTarget, { project, name, timeout_ms: args.timeout_ms || 300000 });
      const reference = args.image || template.image?.reference || template.image_reference || template.immutable_reference || template.source?.reference;
      const environment = asObject(args.environment || args.env || {}, 'environment');
      const containerName = safeName(args.container_name || 'sezu-service', 'service container name');
      const command = args.command || template.command || [];
      const ports = args.ports || template.ports || [];
      const runArgv = serviceDockerRunArguments({ reference, environment, volumes, ports, command, dockerArgs: args.docker_args || [], containerName });
      const target = `cell:${name}`;
      await call(this, 'sezu.exec', target, { argv: ['/bin/bash', '-lc', 'for i in $(seq 1 240); do docker info >/dev/null 2>&1 && exit 0; sleep 0.25; done; exit 1'], cwd: '/', timeout_ms: args.timeout_ms || 300000 });
      const pulled = await call(this, 'sezu.exec', target, { argv: ['docker', 'pull', reference], cwd: '/', timeout_ms: args.timeout_ms || 600000 });
      const running = await call(this, 'sezu.exec', target, { argv: runArgv, cwd: '/', timeout_ms: args.timeout_ms || 300000 });
      service = { reference, container_name: containerName, ports, pull: pulled.result, run: running.result };
    }
    return { status: launched.status, handle: launched.handle, result: { template: template.template_id, instance: name, launched: launched.result, service, published_ports: template.kind === 'service' ? (args.ports || template.ports || []) : [] } };
  }, { family: 'template' });
  runtime.register('sezu.template.delete-instance', async function (args, target) {
    const name = safeName(required(args, 'name', 'string'), 'instance name'); const project = args.project || 'sezu'; let devices = {};
    try { devices = (await call(this, 'sezu.device.list', target, { project, instance: name })).result.devices || {}; } catch {}
    try {
      const state = await call(this, 'sezu.cell.status', target, { project, name });
      if (state.result?.status !== 'Stopped') await call(this, 'sezu.cell.stop', target, { project, name, force: args.force ?? true, timeout_ms: args.timeout_ms || 180000 });
    } catch (error) { if (error.code !== 'incus_error') throw error; }
    await call(this, 'sezu.cell.delete', target, { project, name, wait: args.wait, timeout_ms: args.timeout_ms || 180000 });
    const preserved = []; const deleted = [];
    for (const [device, config] of Object.entries(devices)) if (config.type === 'disk' && config.pool && config.source && config.path !== '/') {
      if (args.delete_volumes === true || (args.delete_volume_names || []).includes(config.source)) { await call(this, 'sezu.volume.delete', target, { project, pool: config.pool, name: config.source }); deleted.push(config.source); }
      else preserved.push(config.source);
    }
    return { result: { deleted_instance: name, preserved_volumes: [...new Set(preserved)], deleted_volumes: [...new Set(deleted)] } };
  }, { family: 'template' });

  runtime.register('sezu.timer.create', async args => {
    const name = safeName(required(args, 'name', 'string'), 'timer name'); const p = timerPaths(name); if (await exists(p.metadata) && !args.replace) throw new SezuError('timer_exists', `timer already exists: ${name}`); await ensureDir(ROOTS.timers);
    const request = timerRequest(args); await atomicJson(p.request, request, 0o600);
    const service = `[Unit]\nDescription=SEZU explicit timer ${name}\nAfter=sezu-supervisor.service\nRequires=sezu-supervisor.service\n\n[Service]\nType=oneshot\nExecStart=/usr/local/bin/sezu --request-file ${p.request} --json\n`;
    const schedule = args.on_calendar ? `OnCalendar=${args.on_calendar}` : args.on_active_sec ? `OnActiveSec=${args.on_active_sec}` : args.on_unit_active_sec ? `OnUnitActiveSec=${args.on_unit_active_sec}` : null;
    if (!schedule) throw new SezuError('invalid_request', 'timer requires on_calendar, on_active_sec, or on_unit_active_sec');
    const timer = `[Unit]\nDescription=SEZU explicit timer ${name}\n\n[Timer]\n${schedule}\nPersistent=${args.persistent ? 'true' : 'false'}\nUnit=${p.stem}.service\n\n[Install]\nWantedBy=timers.target\n`;
    await fsp.writeFile(p.service, service, { mode: 0o644 }); await fsp.writeFile(p.timer, timer, { mode: 0o644 }); const record = { name, created_at: now(), request, schedule, enabled: args.enable !== false, service: p.service, timer: p.timer };
    await atomicJson(p.metadata, record); await hostCommand(['systemctl', 'daemon-reload']); if (record.enabled) await hostCommand(['systemctl', 'enable', '--now', `${p.stem}.timer`]); return { result: record };
  }, { family: 'timer' });
  runtime.register('sezu.timer.list', async () => { await ensureDir(ROOTS.timers); const timers = []; for (const e of await fsp.readdir(ROOTS.timers, { withFileTypes: true })) if (e.isFile() && e.name.endsWith('.json') && !e.name.endsWith('.request.json')) { const t = await readJson(path.join(ROOTS.timers, e.name), null); if (t) { const state = await hostCommand(['systemctl', 'show', `${timerPaths(t.name).stem}.timer`, '--property=ActiveState,UnitFileState,NextElapseUSecRealtime', '--value']).catch(() => ({ stdout: Buffer.from('') })); timers.push({ ...t, systemd: state.stdout.toString('utf8').trim().split('\n') }); } } return { result: { timers } }; }, { mutating: false, family: 'timer' });
  runtime.register('sezu.timer.run', async args => { const name = safeName(required(args, 'name', 'string'), 'timer name'); const p = timerPaths(name); if (!(await exists(p.metadata))) throw new SezuError('timer_not_found', `timer not found: ${name}`); await hostCommand(['systemctl', 'start', `${p.stem}.service`]); const result = await hostCommand(['systemctl', 'show', `${p.stem}.service`, '--property=Result,ExecMainStatus,ExecMainCode,ActiveState', '--value']); return { result: { name, state: result.stdout.toString('utf8').trim().split('\n') } }; }, { family: 'timer' });
  runtime.register('sezu.timer.delete', async args => { const name = safeName(required(args, 'name', 'string'), 'timer name'); const p = timerPaths(name); await hostCommand(['systemctl', 'disable', '--now', `${p.stem}.timer`]).catch(() => {}); await fsp.rm(p.service, { force: true }); await fsp.rm(p.timer, { force: true }); await fsp.rm(p.request, { force: true }); await fsp.rm(p.metadata, { force: true }); await hostCommand(['systemctl', 'daemon-reload']); return { result: { deleted: name } }; }, { family: 'timer' });

  runtime.register('sezu.backup.run', async function (args, target) {
    if (args.instance) return await this.handlers.get('sezu.cell.backup.export').call(this, args, target, { operation: 'sezu.cell.backup.export' });
    if (args.volume) return await this.handlers.get('sezu.volume.backup.export').call(this, args, target, { operation: 'sezu.volume.backup.export' });
    const sources = await backupSources(args); const name = args.name || `sezu-backup-${Date.now()}.tar.gz`; const destination = args.destination || {};
    let output = destination.path || path.join(ROOTS.storage, name); await ensureDir(path.dirname(output));
    const relativeSources = sources.map(source => source.replace(/^\/+/, '')).filter(Boolean);
    const argv = ['tar', '-C', '/', '-czf', output, '--xattrs', '--acls', '--sparse', ...relativeSources];
    await hostCommand(argv, { timeout_ms: args.timeout_ms });
    let artifact = null; if (destination.artifact || args.artifact || !destination.path) artifact = await artifactFromFile(output, { name, kind: 'sezu-backup', resources: sources, created_at: now() });
    if (destination.s3) { const rclone = await hostCommand(['/bin/sh', '-c', 'command -v rclone']); if (!rclone.stdout.length) throw new SezuError('configuration_required', 'rclone is required for an S3-compatible backup destination'); await hostCommand(['rclone', 'copyto', output, destination.s3]); }
    if (!destination.path) await fsp.rm(output, { force: true }); return { artifacts: artifact ? [artifact] : [], result: { name, resources: sources, path: destination.path || null, artifact } };
  }, { family: 'backup' });
  runtime.register('sezu.backup.restore', async function (args, target) {
    if (args.kind === 'instance') return await this.handlers.get('sezu.cell.backup.import').call(this, args, target, { operation: 'sezu.cell.backup.import' });
    if (args.kind === 'volume') return await this.handlers.get('sezu.volume.backup.import').call(this, args, target, { operation: 'sezu.volume.backup.import' });
    let source = args.path; if (args.artifact_id || args.artifact) source = artifactPath(args.artifact_id || args.artifact).file; if (!source) throw new SezuError('invalid_request', 'restore requires path or artifact_id'); const destination = args.destination || '/'; await ensureDir(destination); await hostCommand(['tar', '-xzf', source, '-C', destination, '--xattrs', '--acls', '--sparse', ...(args.strip_components ? [`--strip-components=${args.strip_components}`] : [])], { timeout_ms: args.timeout_ms }); return { result: { restored_from: source, destination } };
  }, { family: 'backup' });
}
