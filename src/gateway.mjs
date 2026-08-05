#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { VERSION, PROTOCOL, socketCall } from './util.mjs';

const server = new McpServer({ name: 'sezu', version: VERSION }, { capabilities: { tools: {} } });
server.registerTool('call_sezu', {
  title: 'Call SEZU',
  description: 'Run one native SEZU operation through the local root supervisor.',
  inputSchema: {
    operation: z.string().min(1),
    target: z.string().regex(/^(host|u|cell:[A-Za-z0-9][A-Za-z0-9._-]{0,127})$/).optional(),
    args: z.record(z.string(), z.unknown()).optional(),
    idempotency_key: z.string().min(1).max(512).optional()
  },
  annotations: { title: 'Call SEZU', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
}, async input => {
  try {
    const response = await socketCall({ operation: input.operation, target: input.target, args: input.args || {}, idempotency_key: input.idempotency_key });
    return {
      content: [{ type: 'text', text: JSON.stringify(response) }],
      structuredContent: response,
      isError: !response.ok
    };
  } catch (error) {
    console.error(`SEZU gateway supervisor call failed: ${error.stack || error.message}`);
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: false, protocol: PROTOCOL, error: { code: error.code || 'gateway_failure', message: error.message } }) }],
      isError: true
    };
  }
});

const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 16 * 1024 * 1024 });
transport.onerror = error => console.error(`SEZU MCP transport error: ${error.stack || error.message}`);
await server.connect(transport);
