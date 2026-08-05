#!/usr/bin/env node
import fsp from 'node:fs/promises';
import net from 'node:net';
import { createRuntime } from './runtime.mjs';
import { SOCKET_PATH, SezuError, encodeFrame, failureEnvelope, frameReader } from './util.mjs';

if (process.getuid?.() !== 0) throw new Error('sezu supervisor must run as root');
const runtime = await createRuntime();
await fsp.mkdir('/run/sezu', { recursive: true, mode: 0o750 });
await fsp.rm(SOCKET_PATH, { force: true });

const groupLine = (await fsp.readFile('/etc/group', 'utf8')).split('\n').find(line => line.startsWith('sezu:'));
if (!groupLine) throw new Error('sezu group does not exist');
const groupId = Number(groupLine.split(':')[2]);

const server = net.createServer(socket => {
  let queue = Promise.resolve();
  const writeFailure = error => {
    const response = failureEnvelope({ operation: 'sezu.health' }, 'u', error);
    if (!socket.destroyed) socket.write(encodeFrame(response));
  };
  const reader = frameReader(request => {
    queue = queue.then(async () => {
      const response = await runtime.dispatch(request);
      if (!socket.destroyed) socket.write(encodeFrame(response));
    }).catch(writeFailure);
  }, writeFailure);
  socket.on('data', reader);
  socket.on('error', error => console.error(`client socket error: ${error.message}`));
});
server.on('error', error => { console.error(`supervisor server error: ${error.stack || error.message}`); process.exitCode = 1; });
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(SOCKET_PATH, resolve); });
await fsp.chown(SOCKET_PATH, 0, groupId);
await fsp.chmod(SOCKET_PATH, 0o660);
console.error(`sezu supervisor ${process.pid} listening on ${SOCKET_PATH}`);

let closing = false;
async function shutdown(signal) {
  if (closing) return; closing = true; console.error(`sezu supervisor received ${signal}`);
  await new Promise(resolve => server.close(resolve)); await fsp.rm(SOCKET_PATH, { force: true }); process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', error => { console.error(error.stack || error); process.exit(1); });
process.on('unhandledRejection', error => { console.error(error?.stack || error); process.exit(1); });
