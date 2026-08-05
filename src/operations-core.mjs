import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {
  ROOTS, VERSION, PROTOCOL, PROJECT, SOCKET_PATH, INLINE_LIMIT, SezuError,
  artifactFromFile, asArray, asObject, asString, atomicJson, boundedInt,
  commandSpec, decodeData, encodeData, ensureDir, exists, incusJson, inlineFile,
  now, readJson, readRange, required, runIncusCli, runProcess, safeName, sha256,
  targetInstance, uuid
} from './util.mjs';

const JOB_RUNNER = '/opt/sezu/current/src/job-runner.mjs';
const NODE = '/opt/sezu/toolchains/node/24.19.0/bin/node';
const TERMINAL_PREFIX = 'sezu-terminal-';

async function inputBuffer(args) {
  if (args.stdin_artifact) {
    const id = String(args.stdin_artifact).replace(/^sha256:/, '');
    if (!/^[0-9a-f]{64}$/.test(id)) throw new SezuError('invalid_artifact', 'stdin_artifact must be a sha256 artifact id');
    return await fsp.readFile(path.join(ROOTS.artifacts, 'sha256', id));
  }
  if (args.stdin === undefined || args.stdin === null) return null;
  if (typeof args.stdin === 'string') return Buffer.from(args.stdin, args.stdin_encoding || 'utf8');
  if (typeof args.stdin === 'object' && typeof args.stdin.data === 'string') return Buffer.from(args.stdin.data, args.stdin.encoding || 'base64');
  throw new SezuError('invalid_request', 'stdin must be a string, encoded data object, or artifact handle');
}

async function finishProcess(result, args = {}) {
  const encoding = args.output_encoding || 'utf8';
  const artifacts = [];
  let truncated = false;
  const stdout = await inlineFile(result.stdoutPath, encoding, INLINE_LIMIT);
  const stderr = await inlineFile(result.stderrPath, encoding, INLINE_LIMIT);
  if (stdout.truncated) {
    artifacts.push(await artifactFromFile(result.stdoutPath, { name: 'stdout', media_type: 'application/octet-stream', stream: 'stdout' }));
    truncated = true;
  }
  if (stderr.truncated) {
    artifacts.push(await artifactFromFile(result.stderrPath, { name: 'stderr', media_type: 'application/octet-stream', stream: 'stderr' }));
    truncated = true;
  }
  await fsp.rm(result.tempDir, { recursive: true, force: true });
  const status = result.timedOut ? 'interrupted' : (result.code === 0 && !result.signal ? 'completed' : 'failed');
  const error = status === 'completed' ? null : {
    code: result.timedOut ? 'process_timeout' : 'process_failed',
    message: stderr.text || (result.signal ? `process terminated by ${result.signal}` : `process exited with code ${result.code}`),
    details: { exit_code: result.code, signal: result.signal, timed_out: result.timedOut }
  };
  return {
    ok: status === 'completed', status, exit_code: result.code, signal: result.signal,
    stdout: stdout.text, stderr: stderr.text, truncated, artifacts, error,
    result: { stdout_bytes: stdout.bytes, stderr_bytes: stderr.bytes, timed_out: result.timedOut, output_encoding: encoding }
  };
}

async function execute(target, args) {
  if (args.mode === 'durable' || args.durable === true) throw new SezuError('use_job_start', 'durable execution must be submitted through sezu.job.start');
  const spec = commandSpec(target, args);
  const result = await runProcess(spec.argv, { cwd: spec.cwd, env: spec.env, stdin: await inputBuffer(args), timeout_ms: args.timeout_ms });
  return await finishProcess(result, args);
}

function jobPaths(id) {
  safeName(id, 'job_id');
  const dir = path.join(ROOTS.jobs, id);
  return { dir, metadataPath: path.join(dir, 'metadata.json'), stdout: path.join(dir, 'stdout'), stderr: path.join(dir, 'stderr'), control: path.join(dir, 'control.sock') };
}

async function getJob(id) {
  const p = jobPaths(id);
  const metadata = await readJson(p.metadataPath, null);
  if (!metadata) throw new SezuError('job_not_found', `job not found: ${id}`);
  return { ...p, record: metadata };
}

async function jobControl(id, message) {
  const job = await getJob(id);
  if (!(await exists(job.control))) throw new SezuError('job_not_running', `job control socket is unavailable: ${id}`, { state: job.record.state });
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(job.control); let data = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.end(JSON.stringify(message)));
    socket.on('data', c => { data += c; });
    socket.on('error', reject);
    socket.on('close', () => {
      try {
        const response = JSON.parse(data.trim());
        if (!response.ok) reject(new SezuError(response.error?.code || 'operation_failed', response.error?.message || 'job control failed'));
        else resolve(response.result);
      } catch (e) { reject(e instanceof SezuError ? e : new SezuError('job_control_failed', e.message)); }
    });
  });
}

async function targetRun(target, argv, options = {}) {
  const spec = commandSpec(target, { argv, cwd: options.cwd, env: options.env || {} });
  const result = await runProcess(spec.argv, { cwd: spec.cwd, env: spec.env, stdin: options.stdin, timeout_ms: options.timeout_ms });
  const stdout = await fsp.readFile(result.stdoutPath); const stderr = await fsp.readFile(result.stderrPath);
  await fsp.rm(result.tempDir, { recursive: true, force: true });
  if (result.code !== 0 || result.signal) throw new SezuError(options.code || 'target_command_failed', stderr.toString('utf8').trim() || `${argv[0]} failed`, { exit_code: result.code, signal: result.signal, stdout: stdout.toString('utf8') });
  return { stdout, stderr };
}

async function targetJson(target, script, values = []) {
  const result = await targetRun(target, ['python3', '-c', script, ...values.map(String)]);
  try { return JSON.parse(result.stdout.toString('utf8')); }
  catch (e) { throw new SezuError('target_response_invalid', `target returned invalid JSON: ${e.message}`, { stdout: result.stdout.toString('utf8').slice(0, 4096) }); }
}

function terminalPaths(name) {
  safeName(name, 'terminal name');
  return { metadataPath: path.join(ROOTS.terminals, `${name}.json`), scrollback: path.join(ROOTS.terminals, `${name}.scrollback`) };
}

async function getTerminal(name) {
  const p = terminalPaths(name); const metadata = await readJson(p.metadataPath, null);
  if (!metadata) throw new SezuError('terminal_not_found', `terminal not found: ${name}`);
  return { ...p, record: metadata };
}

async function tmux(args, options = {}) {
  const r = await runProcess(['tmux', ...args], options);
  const stdout = await fsp.readFile(r.stdoutPath); const stderr = await fsp.readFile(r.stderrPath);
  await fsp.rm(r.tempDir, { recursive: true, force: true });
  if (r.code !== 0 && !options.allowFailure) throw new SezuError('terminal_failed', stderr.toString('utf8').trim() || `tmux exited ${r.code}`, { argv: args, exit_code: r.code });
  return { code: r.code, stdout, stderr };
}

async function terminalAlive(metadata) {
  return (await tmux(['has-session', '-t', metadata.session], { allowFailure: true })).code === 0;
}

async function pathCommand(target, argv) {
  const r = await targetRun(target, argv);
  return { stdout: r.stdout.toString('utf8'), stderr: r.stderr.toString('utf8'), exit_code: 0, result: { argv } };
}

export function registerCoreOperations(runtime) {
  runtime.register('sezu.health', async function () {
    const checks = {};
    checks.supervisor = { ready: true, pid: process.pid };
    checks.socket = { ready: await exists(SOCKET_PATH), path: SOCKET_PATH };
    checks.host = { ready: true, hostname: os.hostname(), uid: process.getuid?.() };
    try {
      const response = await incusJson('GET', '/1.0/instances/u/state', { project: PROJECT });
      checks.u = { ready: response.metadata?.status === 'Running', status: response.metadata?.status };
    } catch (e) { checks.u = { ready: false, error: e.message }; }
    try {
      const response = await incusJson('GET', '/1.0');
      checks.incus = { ready: true, version: response.metadata?.environment?.server_version || null };
    } catch (e) { checks.incus = { ready: false, error: e.message }; }
    for (const [key, dir] of Object.entries({ jobs: ROOTS.jobs, terminals: ROOTS.terminals, artifacts: ROOTS.artifacts, packs: ROOTS.packs, browser_profiles: ROOTS.browser })) {
      checks[key] = { ready: await exists(dir), path: dir };
    }
    const ready = Object.values(checks).every(x => x.ready !== false);
    return { ok: ready, status: ready ? 'completed' : 'failed', result: { ready, checks }, error: ready ? null : { code: 'not_ready', message: 'one or more local runtime checks failed', details: checks } };
  }, { mutating: false, family: 'discovery' });

  runtime.register('sezu.version', async () => ({ result: { product: 'sezu', version: VERSION, protocol: PROTOCOL, node: process.version, commit: await readJson('/opt/sezu/current/version.json', {}).then(x => x.commit || null) } }), { mutating: false, family: 'discovery' });

  runtime.register('sezu.capabilities', async function () {
    let incus = null;
    try { incus = (await incusJson('GET', '/1.0')).metadata; } catch {}
    const packs = await this.handlers.get('sezu.pack.list').call(this, {}, 'u', { operation: 'sezu.pack.list' });
    const skills = await this.handlers.get('sezu.skill.list').call(this, {}, 'u', { operation: 'sezu.skill.list' });
    const templates = await this.handlers.get('sezu.template.list').call(this, {}, 'u', { operation: 'sezu.template.list' });
    return { result: { operations: this.operationNames(), operation_count: this.operationNames().length, target_types: ['host', 'u', 'cell:<name>'], packs: packs.result || packs, skills: skills.result || skills, templates: templates.result || templates, browser_engine: 'playwright-chromium', incus: incus ? { version: incus.environment?.server_version, api_extensions: incus.api_extensions } : null } };
  }, { mutating: false, family: 'discovery' });

  runtime.register('sezu.exec', async function (args, target) {
    if (args.mode === 'durable' || args.durable === true) return await this.handlers.get('sezu.job.start').call(this, args, target, { operation: 'sezu.job.start' });
    if (args.mode === 'terminal' || args.terminal === true) return await this.handlers.get('sezu.terminal.create').call(this, { ...args, name: args.name || `exec-${uuid()}` }, target, { operation: 'sezu.terminal.create' });
    return await execute(target, args);
  }, { family: 'execution' });

  runtime.register('sezu.job.start', async (args, target) => {
    const id = args.job_id ? safeName(args.job_id, 'job_id') : uuid();
    const p = jobPaths(id);
    if (await exists(p.metadataPath)) throw new SezuError('job_exists', `job already exists: ${id}`);
    await ensureDir(p.dir, 0o750); await fsp.writeFile(p.stdout, Buffer.alloc(0), { mode: 0o640 }); await fsp.writeFile(p.stderr, Buffer.alloc(0), { mode: 0o640 });
    const spec = commandSpec(target, args);
    const metadata = { job_id: id, target, state: 'starting', created_at: now(), updated_at: now(), started_at: null, completed_at: null, command_spec: spec, request: { argv: args.argv || null, command: args.command || null, cwd: args.cwd || null }, timeout_ms: args.timeout_ms || 0, pid: null, runner_pid: null, unit: `sezu-job-${id.replace(/[^A-Za-z0-9_.-]/g, '-')}`, exit_code: null, signal: null };
    await atomicJson(p.metadataPath, metadata);
    const unitArgs = ['--unit', metadata.unit, '--property=Type=exec', '--property=KillMode=mixed', '--collect', '--quiet', NODE, JOB_RUNNER, p.metadataPath];
    const launched = await runProcess(['systemd-run', ...unitArgs]);
    const stderr = await fsp.readFile(launched.stderrPath); const stdout = await fsp.readFile(launched.stdoutPath);
    await fsp.rm(launched.tempDir, { recursive: true, force: true });
    if (launched.code !== 0) {
      await atomicJson(p.metadataPath, { ...metadata, state: 'failed', completed_at: now(), error: { code: 'job_launch_failed', message: stderr.toString('utf8') } });
      throw new SezuError('job_launch_failed', stderr.toString('utf8').trim() || 'systemd-run failed', { stdout: stdout.toString('utf8') });
    }
    const deadline = Date.now() + 5000;
    let current = metadata;
    while (Date.now() < deadline) { current = await readJson(p.metadataPath); if (current.state !== 'starting') break; await new Promise(r => setTimeout(r, 50)); }
    return { status: current.state === 'running' ? 'running' : current.state, handle: id, result: current };
  }, { family: 'jobs' });

  runtime.register('sezu.job.status', async args => ({ result: (await getJob(required(args, 'job_id', 'string'))).record }), { mutating: false, family: 'jobs' });

  runtime.register('sezu.job.output', async args => {
    const job = await getJob(required(args, 'job_id', 'string'));
    const stream = args.stream || 'stdout'; if (!['stdout', 'stderr'].includes(stream)) throw new SezuError('invalid_request', 'stream must be stdout or stderr');
    const range = await readRange(stream === 'stdout' ? job.stdout : job.stderr, args.offset || 0, args.limit || INLINE_LIMIT);
    return { status: job.record.state, handle: job.record.job_id, result: { stream, data: encodeData(range.buffer, args.encoding || 'base64'), encoding: args.encoding || 'base64', offset: range.offset, next_offset: range.next_offset, size: range.size, eof: range.eof } };
  }, { mutating: false, family: 'jobs' });

  runtime.register('sezu.job.stdin', async args => {
    const id = required(args, 'job_id', 'string');
    if (args.close || args.eof) return { status: 'running', handle: id, result: await jobControl(id, { type: 'stdin_end' }) };
    const data = required(args, 'data', 'string');
    return { status: 'running', handle: id, result: await jobControl(id, { type: 'stdin', data, encoding: args.encoding || 'base64' }) };
  }, { family: 'jobs' });
  runtime.register('sezu.job.signal', async args => ({ status: 'running', handle: args.job_id, result: await jobControl(required(args, 'job_id', 'string'), { type: 'signal', signal: required(args, 'signal') }) }), { family: 'jobs' });
  runtime.register('sezu.job.pause', async args => ({ status: 'paused', handle: args.job_id, result: await jobControl(required(args, 'job_id', 'string'), { type: 'pause' }) }), { family: 'jobs' });
  runtime.register('sezu.job.resume', async args => ({ status: 'running', handle: args.job_id, result: await jobControl(required(args, 'job_id', 'string'), { type: 'resume' }) }), { family: 'jobs' });
  runtime.register('sezu.job.cancel', async args => ({ status: 'running', handle: args.job_id, result: await jobControl(required(args, 'job_id', 'string'), { type: 'cancel', signal: args.signal || 'SIGTERM' }) }), { family: 'jobs' });
  runtime.register('sezu.job.list', async args => {
    await ensureDir(ROOTS.jobs); const jobs = [];
    for (const entry of await fsp.readdir(ROOTS.jobs, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue; const m = await readJson(path.join(ROOTS.jobs, entry.name, 'metadata.json'), null); if (m && (!args.state || m.state === args.state)) jobs.push(m);
    }
    jobs.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return { result: { jobs: jobs.slice(0, args.limit || 1000), count: jobs.length } };
  }, { mutating: false, family: 'jobs' });
  runtime.register('sezu.job.delete', async args => {
    const job = await getJob(required(args, 'job_id', 'string'));
    if (['starting', 'running', 'paused'].includes(job.record.state)) throw new SezuError('job_running', 'running jobs must be cancelled and completed before deletion');
    await fsp.rm(job.dir, { recursive: true, force: true });
    await runProcess(['systemctl', 'reset-failed', job.record.unit]).then(async r => fsp.rm(r.tempDir, { recursive: true, force: true })).catch(() => {});
    return { result: { deleted: job.record.job_id } };
  }, { family: 'jobs' });
  runtime.register('sezu.job.wait', async args => {
    const id = required(args, 'job_id', 'string'); const timeout = boundedInt(args.timeout_ms, 'timeout_ms', 0, 24 * 60 * 60 * 1000); const start = Date.now();
    while (true) {
      const job = await getJob(id); if (!['starting', 'running', 'paused'].includes(job.record.state)) return { status: job.record.state, handle: id, exit_code: job.record.exit_code, signal: job.record.signal, result: job.record };
      if (timeout && Date.now() - start >= timeout) return { status: job.record.state, handle: id, result: { ...job.record, wait_timed_out: true } };
      await new Promise(r => setTimeout(r, 100));
    }
  }, { mutating: false, family: 'jobs' });
  runtime.register('sezu.job.group', async function (args, defaultTarget) {
    const steps = asArray(required(args, 'steps'), 'steps'); const mode = args.mode || 'sequential';
    const runStep = async (step, index, prior = []) => {
      const target = step.target || defaultTarget; const operation = step.operation || 'sezu.job.start';
      const response = await this.dispatch({ operation, target, args: step.args || step, request_id: uuid(), idempotency_key: step.idempotency_key });
      return { index, response };
    };
    let results = [];
    if (mode === 'parallel' || mode === 'fanout') results = await Promise.all(steps.map((s, i) => runStep(s, i)));
    else if (mode === 'dependency') {
      const pending = new Map(steps.map((s, i) => [i, s]));
      while (pending.size) {
        const ready = [...pending].filter(([i, s]) => (s.depends_on || []).every(d => results.some(r => r.index === d && r.response.ok)));
        if (!ready.length) throw new SezuError('dependency_deadlock', 'job group dependencies cannot be satisfied', { pending: [...pending.keys()] });
        const batch = await Promise.all(ready.map(([i, s]) => runStep(s, i, results)));
        results.push(...batch); for (const [i] of ready) pending.delete(i);
      }
      results.sort((a, b) => a.index - b.index);
    } else {
      for (let i = 0; i < steps.length; i++) { const r = await runStep(steps[i], i, results); results.push(r); if (!r.response.ok && args.stop_on_error !== false) break; }
    }
    return { ok: results.every(x => x.response.ok), status: results.every(x => x.response.ok) ? 'completed' : 'failed', result: { mode, results } };
  }, { family: 'jobs' });

  runtime.register('sezu.process.list', async (args, target) => {
    const r = await targetRun(target, ['ps', '-eo', 'pid=,ppid=,uid=,gid=,stat=,ni=,psr=,etimes=,comm=,args=', '--sort', 'pid']);
    return { stdout: r.stdout.toString('utf8'), result: { format: 'pid ppid uid gid stat nice cpu elapsed command args' } };
  }, { mutating: false, family: 'process' });
  runtime.register('sezu.process.stat', async (args, target) => {
    const pid = String(required(args, 'pid'));
    const script = `import json,os,sys\np=sys.argv[1]\nr={'pid':int(p)}\nfor n in ['status','stat','cmdline','cgroup']:\n try:\n  b=open('/proc/'+p+'/'+n,'rb').read(); r[n]=b.replace(b'\\0',b' ').decode('utf-8','replace')\n except Exception as e:r[n+'_error']=str(e)\ntry:r['exe']=os.readlink('/proc/'+p+'/exe')\nexcept Exception as e:r['exe_error']=str(e)\nprint(json.dumps(r))`;
    return { result: await targetJson(target, script, [pid]) };
  }, { mutating: false, family: 'process' });
  runtime.register('sezu.process.tree', async (args, target) => {
    const argv = ['ps', '-eo', 'pid,ppid,uid,stat,ni,psr,comm,args', '--forest']; if (args.pid) argv.push('--ppid', String(args.pid), '-p', String(args.pid));
    const r = await targetRun(target, argv); return { stdout: r.stdout.toString('utf8'), result: { pid: args.pid || null } };
  }, { mutating: false, family: 'process' });
  runtime.register('sezu.process.signal', async (args, target) => await pathCommand(target, ['kill', `-${String(required(args, 'signal'))}`, String(required(args, 'pid'))]), { family: 'process' });
  runtime.register('sezu.process.pause', async (args, target) => await pathCommand(target, ['kill', '-STOP', String(required(args, 'pid'))]), { family: 'process' });
  runtime.register('sezu.process.resume', async (args, target) => await pathCommand(target, ['kill', '-CONT', String(required(args, 'pid'))]), { family: 'process' });
  runtime.register('sezu.process.renice', async (args, target) => await pathCommand(target, ['renice', '-n', String(required(args, 'nice')), '-p', String(required(args, 'pid'))]), { family: 'process' });
  runtime.register('sezu.process.affinity', async (args, target) => await pathCommand(target, ['taskset', '-pc', Array.isArray(args.cpus) ? args.cpus.join(',') : String(required(args, 'cpus')), String(required(args, 'pid'))]), { family: 'process' });
  runtime.register('sezu.process.cgroup', async (args, target) => {
    const pid = String(required(args, 'pid')); const cgroup = asString(required(args, 'cgroup'), 'cgroup'); const properties = asObject(args.properties || {});
    const script = `set -e\ncg="$1"; pid="$2"; shift 2\ncase "$cg" in /*) ;; *) cg="/sys/fs/cgroup/$cg";; esac\nmkdir -p "$cg"\nwhile [ "$#" -gt 1 ]; do printf '%s' "$2" > "$cg/$1"; shift 2; done\nprintf '%s' "$pid" > "$cg/cgroup.procs"`;
    const pairs = Object.entries(properties).flatMap(([k, v]) => [k, String(v)]);
    return await pathCommand(target, ['sh', '-c', script, 'sh', cgroup, pid, ...pairs]);
  }, { family: 'process' });

  runtime.register('sezu.terminal.list', async () => {
    await ensureDir(ROOTS.terminals); const terminals = [];
    for (const e of await fsp.readdir(ROOTS.terminals, { withFileTypes: true })) if (e.isFile() && e.name.endsWith('.json')) {
      const m = await readJson(path.join(ROOTS.terminals, e.name), null); if (m) terminals.push({ ...m, alive: await terminalAlive(m) });
    }
    return { result: { terminals, count: terminals.length } };
  }, { mutating: false, family: 'terminal' });
  runtime.register('sezu.terminal.create', async (args, target) => {
    const name = safeName(required(args, 'name', 'string'), 'terminal name'); const p = terminalPaths(name);
    if (await exists(p.metadataPath)) throw new SezuError('terminal_exists', `terminal already exists: ${name}`);
    const session = `${TERMINAL_PREFIX}${sha256(`${target}:${name}`).slice(0, 24)}`; const shell = args.shell || '/bin/bash'; const instance = targetInstance(target);
    const command = instance ? ['incus', 'exec', instance, '--project', args.project || PROJECT, '--', shell] : [shell];
    await fsp.writeFile(p.scrollback, Buffer.alloc(0), { mode: 0o640 });
    const create = ['new-session', '-d', '-s', session, '-x', String(args.cols || 120), '-y', String(args.rows || 40)];
    if (args.cwd) create.push('-c', String(args.cwd)); create.push(...command);
    await tmux(create);
    await tmux(['pipe-pane', '-t', `${session}:0.0`, '-o', `cat >> ${shellQuote(p.scrollback)}`]);
    const metadata = { name, target, session, shell, cwd: args.cwd || null, workspace: args.workspace || null, created_at: now(), closed: false, scrollback: p.scrollback };
    await atomicJson(p.metadataPath, metadata);
    return { status: 'running', handle: name, result: { ...metadata, alive: true } };
  }, { family: 'terminal' });
  runtime.register('sezu.terminal.open', async args => {
    const t = await getTerminal(required(args, 'name', 'string')); const alive = await terminalAlive(t.record);
    if (!alive) throw new SezuError('terminal_not_running', `terminal session is not running: ${t.record.name}`);
    if (t.record.closed) { t.record.closed = false; await atomicJson(t.metadataPath, t.record); }
    return { status: 'running', handle: t.record.name, result: { ...t.record, alive, cursor: (await fsp.stat(t.scrollback)).size } };
  }, { family: 'terminal' });
  runtime.register('sezu.terminal.read', async args => {
    const t = await getTerminal(required(args, 'name', 'string')); const range = await readRange(t.scrollback, args.offset || 0, args.limit || INLINE_LIMIT);
    return { status: (await terminalAlive(t.record)) ? 'running' : 'completed', handle: t.record.name, result: { data: encodeData(range.buffer, args.encoding || 'base64'), encoding: args.encoding || 'base64', offset: range.offset, next_offset: range.next_offset, size: range.size, eof: range.eof } };
  }, { mutating: false, family: 'terminal' });
  runtime.register('sezu.terminal.write', async args => {
    const t = await getTerminal(required(args, 'name', 'string')); if (!(await terminalAlive(t.record))) throw new SezuError('terminal_not_running', 'terminal session is not running');
    const data = decodeData(args); const temp = path.join(ROOTS.storage, `terminal-${uuid()}.input`); await fsp.writeFile(temp, data, { mode: 0o600 });
    const buffer = `sezu-${uuid()}`; try { await tmux(['load-buffer', '-b', buffer, temp]); await tmux(['paste-buffer', '-b', buffer, '-t', `${t.record.session}:0.0`, '-d']); } finally { await fsp.rm(temp, { force: true }); }
    return { status: 'running', handle: t.record.name, result: { bytes_written: data.length } };
  }, { family: 'terminal' });
  runtime.register('sezu.terminal.resize', async args => {
    const t = await getTerminal(required(args, 'name', 'string')); await tmux(['resize-window', '-t', t.record.session, '-x', String(required(args, 'cols')), '-y', String(required(args, 'rows'))]);
    return { status: 'running', handle: t.record.name, result: { cols: Number(args.cols), rows: Number(args.rows) } };
  }, { family: 'terminal' });
  runtime.register('sezu.terminal.interrupt', async args => {
    const t = await getTerminal(required(args, 'name', 'string')); await tmux(['send-keys', '-t', `${t.record.session}:0.0`, 'C-c']); return { status: 'running', handle: t.record.name, result: { interrupted: true } };
  }, { family: 'terminal' });
  runtime.register('sezu.terminal.close', async args => {
    const t = await getTerminal(required(args, 'name', 'string')); t.record.closed = true; t.record.closed_at = now(); await atomicJson(terminalPaths(t.record.name).metadataPath, t.record);
    await tmux(['detach-client', '-s', t.record.session], { allowFailure: true }); return { status: 'completed', handle: t.record.name, result: { closed: true, session_preserved: await terminalAlive(t.record) } };
  }, { family: 'terminal' });
  runtime.register('sezu.terminal.delete', async args => {
    const t = await getTerminal(required(args, 'name', 'string')); await tmux(['kill-session', '-t', t.record.session], { allowFailure: true });
    await fsp.rm(t.metadataPath || terminalPaths(t.record.name).metadataPath, { force: true }); await fsp.rm(t.scrollback, { force: true }); return { result: { deleted: t.record.name } };
  }, { family: 'terminal' });

  const statScript = `import json,os,stat,sys\np=sys.argv[1]; s=os.lstat(p)\nr={'path':p,'mode':s.st_mode,'mode_octal':oct(stat.S_IMODE(s.st_mode)),'uid':s.st_uid,'gid':s.st_gid,'size':s.st_size,'mtime_ns':s.st_mtime_ns,'atime_ns':s.st_atime_ns,'ctime_ns':s.st_ctime_ns,'is_file':stat.S_ISREG(s.st_mode),'is_dir':stat.S_ISDIR(s.st_mode),'is_symlink':stat.S_ISLNK(s.st_mode)}\nif r['is_symlink']:r['link_target']=os.readlink(p)\nprint(json.dumps(r))`;
  runtime.register('sezu.file.stat', async (args, target) => ({ result: await targetJson(target, statScript, [required(args, 'path', 'string')]) }), { mutating: false, family: 'file' });
  runtime.register('sezu.file.list', async (args, target) => {
    const script = `import json,os,stat,sys\nroot=sys.argv[1]; recursive=sys.argv[2]=='1'; maxdepth=int(sys.argv[3]); limit=int(sys.argv[4]); out=[]\ndef add(p,name):\n s=os.lstat(p); out.append({'name':name,'path':p,'mode':s.st_mode,'uid':s.st_uid,'gid':s.st_gid,'size':s.st_size,'is_dir':stat.S_ISDIR(s.st_mode),'is_symlink':stat.S_ISLNK(s.st_mode),'link_target':os.readlink(p) if stat.S_ISLNK(s.st_mode) else None})\nif recursive:\n base=root.rstrip('/')+'/'\n for d,dirs,files in os.walk(root,followlinks=False):\n  depth=(d[len(base):].count('/')+1) if d!=root else 0\n  if depth>=maxdepth:dirs[:]=[]\n  for n in dirs+files:\n   add(os.path.join(d,n),os.path.relpath(os.path.join(d,n),root))\n   if len(out)>=limit:break\n  if len(out)>=limit:break\nelse:\n for n in os.listdir(root)[:limit]:add(os.path.join(root,n),n)\nprint(json.dumps({'entries':out,'count':len(out),'limited':len(out)>=limit}))`;
    return { result: await targetJson(target, script, [required(args, 'path', 'string'), args.recursive ? '1' : '0', args.max_depth ?? 64, args.limit ?? 10000]) };
  }, { mutating: false, family: 'file' });
  runtime.register('sezu.file.read', async (args, target) => {
    const file = required(args, 'path', 'string'); const offset = boundedInt(args.offset, 'offset', 0); const limit = boundedInt(args.limit, 'limit', INLINE_LIMIT, 4 * 1024 * 1024); let range;
    if (target === 'host') range = await readRange(file, offset, limit);
    else {
      const r = await targetRun(target, ['dd', `if=${file}`, 'iflag=skip_bytes,count_bytes', `skip=${offset}`, `count=${limit}`, 'status=none']);
      const stat = await targetJson(target, `import os,sys,json\ns=os.stat(sys.argv[1]);print(json.dumps({'size':s.st_size}))`, [file]);
      range = { buffer: r.stdout, offset, next_offset: offset + r.stdout.length, size: stat.size, eof: offset + r.stdout.length >= stat.size };
    }
    return { result: { data: encodeData(range.buffer, args.encoding || 'base64'), encoding: args.encoding || 'base64', offset: range.offset, next_offset: range.next_offset, size: range.size, eof: range.eof } };
  }, { mutating: false, family: 'file' });
  runtime.register('sezu.file.write', async (args, target) => {
    const file = required(args, 'path', 'string'); const data = decodeData(args); const offset = args.offset; const append = args.append === true;
    if (target === 'host') {
      await ensureDir(path.dirname(file)); let handle;
      if (append) handle = await fsp.open(file, 'a', args.mode || 0o640);
      else if (offset !== undefined) handle = await fsp.open(file, (await exists(file)) ? 'r+' : 'w+', args.mode || 0o640);
      else handle = await fsp.open(file, 'w', args.mode || 0o640);
      try { if (append || offset === undefined) await handle.write(data); else await handle.write(data, 0, data.length, boundedInt(offset, 'offset')); if (args.durable) await handle.sync(); } finally { await handle.close(); }
    } else {
      const script = append ? `cat >> "$1"` : (offset !== undefined ? `dd of="$1" bs=1 seek="$2" conv=notrunc status=none` : `cat > "$1"`);
      await targetRun(target, ['sh', '-c', `mkdir -p "$(dirname -- "$1")"; ${script}`, 'sh', file, String(offset || 0)], { stdin: data });
      if (args.mode !== undefined) await targetRun(target, ['chmod', modeString(args.mode), file]);
    }
    return { result: { path: file, bytes_written: data.length, offset: offset ?? null, append } };
  }, { family: 'file' });
  runtime.register('sezu.file.mkdir', async (args, target) => await pathCommand(target, ['mkdir', ...(args.parents === false ? [] : ['-p']), ...(args.mode !== undefined ? ['-m', modeString(args.mode)] : []), required(args, 'path', 'string')]), { family: 'file' });
  runtime.register('sezu.file.copy', async (args, target) => await pathCommand(target, ['cp', ...(args.recursive ? ['-R'] : []), ...(args.preserve ? ['-a'] : []), ...(args.no_clobber ? ['-n'] : []), required(args, 'source', 'string'), required(args, 'destination', 'string')]), { family: 'file' });
  runtime.register('sezu.file.move', async (args, target) => await pathCommand(target, ['mv', ...(args.force === false ? ['-n'] : ['-f']), required(args, 'source', 'string'), required(args, 'destination', 'string')]), { family: 'file' });
  runtime.register('sezu.file.remove', async (args, target) => await pathCommand(target, ['rm', '-f', ...(args.recursive ? ['-r'] : []), '--', required(args, 'path', 'string')]), { family: 'file' });
  runtime.register('sezu.file.chmod', async (args, target) => await pathCommand(target, ['chmod', ...(args.recursive ? ['-R'] : []), modeString(required(args, 'mode')), required(args, 'path', 'string')]), { family: 'file' });
  runtime.register('sezu.file.chown', async (args, target) => await pathCommand(target, ['chown', ...(args.recursive ? ['-R'] : []), `${required(args, 'owner')}${args.group !== undefined ? ':' + args.group : ''}`, required(args, 'path', 'string')]), { family: 'file' });
  runtime.register('sezu.file.link', async (args, target) => await pathCommand(target, ['ln', ...(args.symbolic ? ['-s'] : []), ...(args.force ? ['-f'] : []), required(args, 'target', 'string'), required(args, 'path', 'string')]), { family: 'file' });
}

function modeString(value) { return typeof value === 'number' ? value.toString(8) : String(value); }
function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }
