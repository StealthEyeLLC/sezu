#!/usr/bin/env node
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const node = process.env.SEZU_NODE || '/opt/sezu/toolchains/node/24.19.0/bin/node';
const gateway = process.env.SEZU_GATEWAY || '/opt/sezu/current/src/gateway.mjs';
const transport = new StdioClientTransport({ command: node, args: [gateway], stderr: 'pipe' });
const client = new Client({ name: 'sezu-phase4-check', version: '0.1.0' });
try {
  await client.connect(transport);
  const listed = await client.listTools();
  if (listed.tools.length !== 1 || listed.tools[0].name !== 'call_sezu') throw new Error(`expected exactly call_sezu, got ${listed.tools.map(x => x.name).join(',')}`);
  const health = await client.callTool({ name: 'call_sezu', arguments: { operation: 'sezu.health', args: {} } });
  const healthEnvelope = JSON.parse(health.content.find(x => x.type === 'text').text);
  if (!healthEnvelope.ok || healthEnvelope.protocol !== 'SEZU1/1.0.0') throw new Error(`health failed: ${JSON.stringify(healthEnvelope)}`);
  const exec = await client.callTool({ name: 'call_sezu', arguments: { operation: 'sezu.exec', target: 'u', args: { argv: ['/bin/printf', 'mcp-ok'] } } });
  const execEnvelope = JSON.parse(exec.content.find(x => x.type === 'text').text);
  if (!execEnvelope.ok || execEnvelope.stdout !== 'mcp-ok') throw new Error(`exec failed: ${JSON.stringify(execEnvelope)}`);
  console.log(JSON.stringify({ ok: true, tools: listed.tools.map(x => x.name), health: healthEnvelope.status, exec_stdout: execEnvelope.stdout }));
} finally {
  await client.close();
}
