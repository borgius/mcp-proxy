#!/usr/bin/env node
// Simple MCP-like server for stdio JSON-RPC used in tests.
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

let nextId = 1;

const tools = [
  { name: 'echo', description: 'Echoes arguments', inputSchema: { type: 'object', properties: { message: { type: 'string' } } } },
  { name: 'sum', description: 'Sums numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } }
];

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (e) {
    // ignore
    return;
  }

  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'mock-stdio', version: '0.1' } } });
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools } });
  } else if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params || {};
    if (name === 'echo') {
      const text = String((args && args.message) || '');
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `Echo: ${text}` }] } });
    } else if (name === 'sum') {
      const a = Number(args?.a || 0);
      const b = Number(args?.b || 0);
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: String(a + b) }] } });
    } else {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
    }
  } else if (msg.method === 'notifications/initialized') {
    // ignore
  } else {
    // unknown - respond generic
    if (msg.id) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Unknown method' } });
    }
  }
});
