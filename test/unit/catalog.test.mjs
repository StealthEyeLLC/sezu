import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../../src/runtime.mjs';

test('catalog and handlers are exactly equal', async () => {
  const runtime = await createRuntime();
  assert.equal(runtime.operationNames().length, 184);
  assert.equal(runtime.handlers.size, 184);
  assert.deepEqual([...runtime.handlers.keys()].sort(), [...runtime.operationNames()].sort());
});

test('workspace defaults merge execution context and preserve explicit overrides', async () => {
  const runtime = await createRuntime();
  const active = {
    path: '/work/demo',
    environment: { FROM_WORKSPACE: 'yes', OVERRIDE: 'workspace' },
    environment_remove: ['REMOVE_ME', 'EXPLICIT'],
    browser_profile: 'workspace-browser',
    task_template: 'task-default'
  };
  const exec = runtime.applyWorkspaceDefaults({ operation: 'sezu.exec', args: { env: { OVERRIDE: 'call', EXPLICIT: 'restored' }, env_remove: ['CALL_REMOVE'] } }, active);
  assert.equal(exec.args.cwd, '/work/demo');
  assert.deepEqual(exec.args.env, { FROM_WORKSPACE: 'yes', OVERRIDE: 'call', EXPLICIT: 'restored' });
  assert.deepEqual(exec.args.env_remove, ['REMOVE_ME', 'CALL_REMOVE']);
  assert.equal(runtime.applyWorkspaceDefaults({ operation: 'sezu.browser.open', args: {} }, active).args.profile, 'workspace-browser');
  assert.equal(runtime.applyWorkspaceDefaults({ operation: 'sezu.browser.run', args: {} }, active).args.profile, 'workspace-browser');
  assert.equal(runtime.applyWorkspaceDefaults({ operation: 'sezu.template.launch', args: {} }, active).args.name, 'task-default');
  assert.equal(runtime.applyWorkspaceDefaults({ operation: 'sezu.terminal.create', args: {} }, active).args.cwd, '/work/demo');
});
