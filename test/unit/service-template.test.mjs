import test from 'node:test';
import assert from 'node:assert/strict';
import { serviceDockerRunArguments } from '../../src/operations-extended.mjs';

test('service templates run immutable images with explicit ports, environment, and volume bindings', () => {
  const argv = serviceDockerRunArguments({
    reference: 'docker.io/library/nginx@sha256:abc',
    environment: { MODE: 'phase6' },
    volumes: [{ path: '/usr/share/nginx/html' }],
    ports: [80],
    command: ['nginx', '-g', 'daemon off;'],
    dockerArgs: ['--label', 'sezu.phase=6'],
    containerName: 'sezu-service'
  });
  assert.deepEqual(argv, [
    'docker', 'run', '--detach', '--name', 'sezu-service', '--restart', 'unless-stopped',
    '--env', 'MODE=phase6', '--publish', '80:80',
    '--volume', '/usr/share/nginx/html:/usr/share/nginx/html',
    '--label', 'sezu.phase=6',
    'docker.io/library/nginx@sha256:abc', 'nginx', '-g', 'daemon off;'
  ]);
});
