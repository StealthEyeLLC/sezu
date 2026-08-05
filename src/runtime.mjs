import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ROOTS, PROTOCOL, SezuError, asObject, atomicJson, baseEnvelope, exists,
  failureEnvelope, initializeState, now, readJson, sha256, stableStringify
} from './util.mjs';
import { registerCoreOperations } from './operations-core.mjs';
import { registerStateOperations } from './operations-state.mjs';
import { registerIncusOperations } from './operations-incus.mjs';
import { registerExtendedOperations } from './operations-extended.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = path.resolve(HERE, '../config/operations/catalog.json');
const IDEMPOTENCY_DIR = path.join(ROOTS.storage, 'idempotency');
const ACTIVE_WORKSPACE = path.join(ROOTS.workspaces, 'active.json');
const CONFIG_PATH = path.join(ROOTS.config, 'config.json');
const RESERVED = new Set(['result', 'stdout', 'stderr', 'truncated', 'artifacts', 'status', 'handle', 'exit_code', 'signal']);

export class Runtime {
  constructor() {
    this.handlers = new Map();
    this.metadata = new Map();
    this.catalog = null;
  }

  register(name, handler, metadata = {}) {
    if (this.handlers.has(name)) throw new Error(`duplicate operation handler: ${name}`);
    if (typeof handler !== 'function') throw new Error(`handler must be a function: ${name}`);
    this.handlers.set(name, handler);
    this.metadata.set(name, { mutating: metadata.mutating !== false, family: metadata.family || 'general' });
  }

  async initialize() {
    await initializeState();
    await fsp.mkdir(IDEMPOTENCY_DIR, { recursive: true, mode: 0o750 });
    this.catalog = await readJson(CATALOG_PATH);
    if (!Array.isArray(this.catalog.operations) || this.catalog.operations.length !== 184) {
      throw new Error(`invalid operation catalog: expected 184, got ${this.catalog?.operations?.length}`);
    }
    registerCoreOperations(this);
    registerStateOperations(this);
    registerIncusOperations(this);
    registerExtendedOperations(this);
    const missing = this.catalog.operations.filter(name => !this.handlers.has(name));
    const extra = [...this.handlers.keys()].filter(name => !this.catalog.operations.includes(name));
    if (missing.length || extra.length || this.handlers.size !== 184) {
      throw new Error(`handler/catalog mismatch: missing=${missing.join(',')} extra=${extra.join(',')} count=${this.handlers.size}`);
    }
    return this;
  }

  async resolveTarget(request) {
    if (request.target !== undefined && request.target !== null) return this.validateTarget(request.target);
    const active = await readJson(ACTIVE_WORKSPACE, null);
    if (active?.default_target) return this.validateTarget(active.default_target);
    const config = await readJson(CONFIG_PATH, { default_target: 'u' });
    return this.validateTarget(config.default_target || 'u');
  }

  validateTarget(target) {
    if (target === 'host' || target === 'u') return target;
    if (typeof target === 'string' && /^cell:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(target)) return target;
    throw new SezuError('invalid_target', `target must be host, u, or cell:<name>; got ${String(target)}`);
  }

  validateRequest(request) {
    const r = asObject(request, 'request');
    if (typeof r.operation !== 'string' || !r.operation.length) throw new SezuError('invalid_request', 'operation is required');
    if (!this.catalog.operations.includes(r.operation)) throw new SezuError('unknown_operation', `unknown operation: ${r.operation}`);
    if (r.args !== undefined) asObject(r.args, 'args');
    if (r.idempotency_key !== undefined && (typeof r.idempotency_key !== 'string' || !r.idempotency_key.length || r.idempotency_key.length > 512)) {
      throw new SezuError('invalid_request', 'idempotency_key must be a nonempty string no longer than 512 bytes');
    }
    return { ...r, args: r.args || {} };
  }

  async dispatch(input) {
    let request = input;
    let target = input?.target || 'u';
    try {
      request = this.validateRequest(input);
      target = await this.resolveTarget(request);
      request.request_id ||= cryptoRandomId();
      const handler = this.handlers.get(request.operation);
      const idempotency = request.idempotency_key ? await this.readIdempotency(request, target) : null;
      if (idempotency) return idempotency;
      const value = await handler.call(this, request.args, target, request);
      const response = this.normalizeResponse(request, target, value);
      if (request.idempotency_key && this.metadata.get(request.operation)?.mutating && response.status !== 'running') {
        await this.writeIdempotency(request, target, response);
      }
      return response;
    } catch (error) {
      const response = failureEnvelope({ operation: request?.operation || 'sezu.health', request_id: request?.request_id || cryptoRandomId() }, target, error);
      if (request?.idempotency_key && request?.operation && this.metadata.get(request.operation)?.mutating && response.status !== 'running') {
        await this.writeIdempotency(request, target, response).catch(() => {});
      }
      return response;
    }
  }

  normalizeResponse(request, target, value) {
    const envelope = baseEnvelope(request, target);
    if (value === undefined) value = null;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const key of RESERVED) if (key in value) envelope[key] = value[key];
      if ('ok' in value) envelope.ok = Boolean(value.ok);
      if ('error' in value) envelope.error = value.error;
      envelope.result = 'result' in value ? value.result : Object.fromEntries(Object.entries(value).filter(([key]) => !RESERVED.has(key) && !['ok', 'error'].includes(key)));
    } else envelope.result = value;
    envelope.protocol = PROTOCOL;
    envelope.operation = request.operation;
    envelope.target = target;
    envelope.request_id = request.request_id;
    if (envelope.ok === false && !envelope.error) envelope.error = { code: 'operation_failed', message: 'operation failed', details: null };
    if (envelope.ok === false && envelope.status === 'completed') envelope.status = 'failed';
    return envelope;
  }

  async readIdempotency(request, target) {
    const keyHash = sha256(request.idempotency_key);
    const file = path.join(IDEMPOTENCY_DIR, `${keyHash}.json`);
    const record = await readJson(file, null);
    if (!record) return null;
    const digest = sha256(stableStringify({ operation: request.operation, target, args: request.args }));
    if (record.digest !== digest) {
      throw new SezuError('idempotency_conflict', 'idempotency key was previously used with materially different input', {
        operation: record.operation, target: record.target, created_at: record.created_at
      });
    }
    return record.response;
  }

  async writeIdempotency(request, target, response) {
    const keyHash = sha256(request.idempotency_key);
    const digest = sha256(stableStringify({ operation: request.operation, target, args: request.args }));
    await atomicJson(path.join(IDEMPOTENCY_DIR, `${keyHash}.json`), {
      key_hash: keyHash, digest, operation: request.operation, target, created_at: now(), response
    }, 0o600);
    await this.pruneIdempotency();
  }

  async pruneIdempotency() {
    const entries = [];
    for (const entry of await fsp.readdir(IDEMPOTENCY_DIR, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const file = path.join(IDEMPOTENCY_DIR, entry.name);
      try { entries.push({ file, mtime: (await fsp.stat(file)).mtimeMs }); } catch {}
    }
    entries.sort((a, b) => b.mtime - a.mtime);
    await Promise.all(entries.slice(256).map(x => fsp.rm(x.file, { force: true })));
  }

  operationNames() { return [...this.catalog.operations]; }
  operationMetadata(name) { return this.metadata.get(name) || null; }
}

function cryptoRandomId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export async function createRuntime() {
  return await new Runtime().initialize();
}
