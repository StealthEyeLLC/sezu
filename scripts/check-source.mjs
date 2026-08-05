#!/usr/bin/env node
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import YAML from 'yaml';
import { createRuntime } from '../src/runtime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = await createRuntime();
const catalog = JSON.parse(await fsp.readFile(path.join(ROOT, 'config/operations/catalog.json'), 'utf8'));
if (catalog.operations.length !== 184 || runtime.handlers.size !== 184) throw new Error('catalog or handler count is not 184');
const missing = catalog.operations.filter(x => !runtime.handlers.has(x));
const extra = [...runtime.handlers.keys()].filter(x => !catalog.operations.includes(x));
if (missing.length || extra.length) throw new Error(`catalog mismatch missing=${missing.join(',')} extra=${extra.join(',')}`);

const ajv = new Ajv2020({ allErrors: true, strict: false });
for (const file of ['config/protocol/request.schema.json','config/protocol/response.schema.json','config/skill.schema.json','config/workspace.schema.json','config/macro.schema.json']) {
  const schema = JSON.parse(await fsp.readFile(path.join(ROOT, file), 'utf8'));
  ajv.compile(schema);
}
for (const dir of ['templates/tasks','templates/services','templates/vms']) {
  for (const entry of await fsp.readdir(path.join(ROOT, dir))) {
    if (!/\.(json|ya?ml)$/.test(entry)) continue;
    const text = await fsp.readFile(path.join(ROOT, dir, entry), 'utf8');
    const value = entry.endsWith('.json') ? JSON.parse(text) : YAML.parse(text);
    if (!value || typeof value !== 'object') throw new Error(`invalid template: ${dir}/${entry}`);
  }
}
for (const dir of ['skills']) {
  for (const entry of await fsp.readdir(path.join(ROOT, dir), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = JSON.parse(await fsp.readFile(path.join(ROOT, dir, entry.name, 'skill.json'), 'utf8'));
    if (!manifest.name || !manifest.entrypoint) throw new Error(`invalid skill: ${entry.name}`);
  }
}
const sourceFiles = (await fsp.readdir(path.join(ROOT, 'src'))).filter(x => x.endsWith('.mjs'));
for (const file of sourceFiles) {
  const text = await fsp.readFile(path.join(ROOT, 'src', file), 'utf8');
  if (/\b(not implemented|TODO operation|unsupported operation)\b/i.test(text)) throw new Error(`stub marker in src/${file}`);
}
console.log(JSON.stringify({ ok: true, operation_count: catalog.operations.length, handler_count: runtime.handlers.size, schemas: 5, source_files: sourceFiles.length }));
