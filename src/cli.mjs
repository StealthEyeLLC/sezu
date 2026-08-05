#!/usr/bin/env node
import fsp from 'node:fs/promises';
import process from 'node:process';
import { VERSION, PROTOCOL, SezuError, socketCall } from './util.mjs';

const argv = process.argv.slice(2);
if (argv.includes('--version') || argv[0] === 'version') { console.log(`sezu ${VERSION} (${PROTOCOL})`); process.exit(0); }
if (argv.includes('--help') || !argv.length) { usage(); process.exit(argv.length ? 0 : 2); }

function option(name, fallback = undefined) {
  const i = argv.indexOf(name); if (i < 0) return fallback; if (i + 1 >= argv.length) throw new SezuError('invalid_cli', `${name} requires a value`); return argv[i + 1];
}
function flag(name) { return argv.includes(name); }
function positional() {
  const valueOptions = new Set(['--target', '--args-json', '--args-file', '--request-file', '--idempotency-key', '--operation', '--socket-timeout', '--terminal-name']);
  const out = []; for (let i = 0; i < argv.length; i++) { if (valueOptions.has(argv[i])) { i++; continue; } if (!argv[i].startsWith('--')) out.push(argv[i]); } return out;
}

let request;
const requestFile = option('--request-file');
if (requestFile) request = JSON.parse(await fsp.readFile(requestFile, 'utf8'));
else {
  const pos = positional(); const operation = option('--operation') || (pos[0] === 'call' ? pos[1] : pos[0]);
  if (!operation) throw new SezuError('invalid_cli', 'operation is required');
  let args = {};
  if (option('--args-json')) args = JSON.parse(option('--args-json'));
  if (option('--args-file')) args = JSON.parse(await fsp.readFile(option('--args-file'), 'utf8'));
  const assignments = pos.slice(pos[0] === 'call' ? 2 : 1).filter(x => x.includes('='));
  for (const assignment of assignments) { const [key, ...rest] = assignment.split('='); const raw = rest.join('='); try { args[key] = JSON.parse(raw); } catch { args[key] = raw; } }
  if (flag('--stdin')) { const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk); args.stdin = { data: Buffer.concat(chunks).toString('base64'), encoding: 'base64' }; }
  request = { operation, target: option('--target'), args, idempotency_key: option('--idempotency-key') };
}
for (const key of Object.keys(request)) if (request[key] === undefined) delete request[key];

const response = await socketCall(request, undefined, Number(option('--socket-timeout', '0')));
if (flag('--json') || requestFile) console.log(JSON.stringify(response, null, 2));
else printHuman(response);

if (flag('--follow') && response.ok && response.handle && ['sezu.job.start', 'sezu.exec'].includes(response.operation)) await followJob(response.handle);
if (flag('--terminal') && response.ok) await terminalLoop(option('--terminal-name') || response.handle);
process.exitCode = response.ok ? 0 : 1;

function printHuman(response) {
  if (response.stdout) process.stdout.write(response.stdout);
  if (response.stderr) process.stderr.write(response.stderr);
  if (response.result !== null && response.result !== undefined && !response.stdout) process.stdout.write(JSON.stringify(response.result, null, 2) + '\n');
  if (!response.ok) process.stderr.write(`${response.error?.code || 'operation_failed'}: ${response.error?.message || 'operation failed'}\n`);
}

async function followJob(jobId) {
  let stdoutOffset = 0; let stderrOffset = 0;
  while (true) {
    for (const stream of ['stdout', 'stderr']) {
      const offset = stream === 'stdout' ? stdoutOffset : stderrOffset;
      const page = await socketCall({ operation: 'sezu.job.output', args: { job_id: jobId, stream, offset, limit: 65536, encoding: 'base64' } });
      if (page.ok) { const data = Buffer.from(page.result.data, 'base64'); (stream === 'stdout' ? process.stdout : process.stderr).write(data); if (stream === 'stdout') stdoutOffset = page.result.next_offset; else stderrOffset = page.result.next_offset; }
    }
    const status = await socketCall({ operation: 'sezu.job.status', args: { job_id: jobId } });
    if (!status.ok || !['starting', 'running', 'paused'].includes(status.result.state)) break;
    await new Promise(r => setTimeout(r, 200));
  }
}

async function terminalLoop(name) {
  if (!name) throw new SezuError('invalid_cli', '--terminal requires a terminal name or a response handle');
  let offset = 0; let stopped = false;
  process.stdin.setRawMode?.(true); process.stdin.resume();
  process.stdin.on('data', async data => { if (data.length === 1 && data[0] === 0x1d) { stopped = true; return; } await socketCall({ operation: 'sezu.terminal.write', args: { name, data: data.toString('base64'), encoding: 'base64' } }); });
  while (!stopped) {
    const page = await socketCall({ operation: 'sezu.terminal.read', args: { name, offset, limit: 65536, encoding: 'base64' } });
    if (!page.ok) break; const data = Buffer.from(page.result.data, 'base64'); if (data.length) process.stdout.write(data); offset = page.result.next_offset; await new Promise(r => setTimeout(r, 100));
  }
  process.stdin.setRawMode?.(false); process.stdin.pause();
}

function usage() {
  console.log(`Usage:\n  sezu <operation> [--target host|u|cell:name] [--args-json JSON] [key=value ...] [--json]\n  sezu call <operation> ...\n  sezu --request-file request.json --json\n\nOptions:\n  --stdin             Read binary stdin into args.stdin\n  --follow            Follow a started durable job\n  --terminal          Open the returned or named terminal (Ctrl-] to detach)\n  --idempotency-key   Optional duplicate-prevention key\n  --version           Print release identity`);
}
