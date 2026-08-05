import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('Python pack closure includes dependencies requested through extras', () => {
  execFileSync('python3', ['scripts/phase3-pack-select.py'], { cwd: root, stdio: 'pipe' });
  const plan = JSON.parse(readFileSync(path.join(root, 'config/forge/base-python-plan.json'), 'utf8'));
  const tinycss = plan.find(item => item.environment === 'data-core' && item.name === 'tinycss2');
  assert.ok(tinycss, 'bleach[css] must include tinycss2 in data-core');
  assert.equal(tinycss.version, '1.5.1');
  assert.equal(tinycss.sha256, '3415ba0f5839c062696996998176c4a3751d18b7edaaeeb658c9ce21ec150661');
});
