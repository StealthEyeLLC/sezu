import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../src/runtime.mjs';

test('cpio archive excludes its destination path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sezu-cpio-'));
  try {
    await writeFile(join(dir, 'input.txt'), 'phase6-cpio\n');
    const output = join(dir, 'output.cpio');
    const runtime = await createRuntime();
    const response = await runtime.dispatch({
      operation: 'sezu.archive.create',
      target: 'host',
      args: { sources: ['input.txt'], destination: output, format: 'cpio', cwd: dir }
    });
    assert.equal(response.ok, true, response.error?.message);
    const listing = execFileSync('cpio', ['-it'], { input: await readFile(output), encoding: 'utf8' })
      .trim().split(/\r?\n/).filter(Boolean);
    assert.deepEqual(listing, ['input.txt']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
