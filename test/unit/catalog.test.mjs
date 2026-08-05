import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../../src/runtime.mjs';

test('catalog and handlers are exactly equal', async () => {
  const runtime = await createRuntime();
  assert.equal(runtime.operationNames().length, 184);
  assert.equal(runtime.handlers.size, 184);
  assert.deepEqual([...runtime.handlers.keys()].sort(), [...runtime.operationNames()].sort());
});
