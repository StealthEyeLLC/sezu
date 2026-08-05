#!/usr/bin/env node
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'build', 'sezu-0.1.0');
await fsp.rm(OUT, { recursive: true, force: true });
await fsp.mkdir(OUT, { recursive: true });

async function copy(relative, destination = relative) {
  const source = path.join(ROOT, relative); const target = path.join(OUT, destination);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.cp(source, target, { recursive: true, force: true, dereference: false, preserveTimestamps: true });
}
for (const item of [
  'src', 'config/operations', 'config/protocol', 'config/skill.schema.json',
  'config/workspace.schema.json', 'config/macro.schema.json', 'config/capabilities.yaml',
  'docs/OPERATION_CATALOG.md', 'docs/CAPABILITY_PACKS.md', 'locks', 'skills', 'templates',
  'systemd/sezu-supervisor.service', 'systemd/sezu-tunnel.service',
  'scripts/install-locked-component.sh', 'scripts/mcp-smoke.mjs', 'scripts/run-tunnel.sh', 'scripts/check-source.mjs', 'scripts/phase4-sezu-check.sh', 'test', 'package.json', 'package-lock.json'
]) await copy(item);
if (!await fsp.stat(path.join(ROOT, 'node_modules')).catch(() => null)) throw new Error('node_modules is missing; run locked npm install in the forge');
const cp = spawnSync('cp', ['-aL', path.join(ROOT, 'node_modules'), path.join(OUT, 'node_modules')], { stdio: 'inherit' });
if (cp.status !== 0) throw new Error(`copying node_modules failed with status ${cp.status}`);
const git = (...args) => {
  const r = spawnSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return r.stdout.trim();
};
const version = {
  product: 'sezu', version: '0.1.0', protocol: 'SEZU1/1.0.0',
  commit: process.env.SEZU_COMMIT || git('rev-parse', 'HEAD'),
  tree: process.env.SEZU_TREE || git('write-tree'),
  node: process.version,
  mcp_sdk: JSON.parse(await fsp.readFile(path.join(OUT, 'node_modules/@modelcontextprotocol/sdk/package.json'), 'utf8')).version,
  playwright: JSON.parse(await fsp.readFile(path.join(OUT, 'node_modules/playwright/package.json'), 'utf8')).version
};
await fsp.writeFile(path.join(OUT, 'version.json'), JSON.stringify(version, null, 2) + '\n');
for (const file of ['src/supervisor.mjs','src/gateway.mjs','src/cli.mjs','src/job-runner.mjs','src/browser-worker.mjs','scripts/install-locked-component.sh','scripts/mcp-smoke.mjs','scripts/run-tunnel.sh','scripts/check-source.mjs','scripts/phase4-sezu-check.sh']) {
  await fsp.chmod(path.join(OUT, file), 0o755);
}
console.log(JSON.stringify({ ok: true, release: OUT, ...version }));
