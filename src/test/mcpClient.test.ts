import * as assert from 'assert';

import * as path from 'path';
import * as cp from 'child_process';
import * as http from 'http';
import * as WebSocket from 'ws';
import { McpClient } from '../mcpClient';

const timeout = (ms: number) => new Promise((r) => setTimeout(r, ms));

suite('McpClient transports', function () {
  this.timeout(10000);

  test('stdio transport: discover tools and call echo & sum', async () => {
    const serverScript = path.resolve(__dirname, '..', '..', 'src', 'test', 'mocks', 'mcp_stdio_server.js');

    const config = {
      command: 'node',
      args: [serverScript],
      env: {}
    };

    const client = new McpClient('test-stdio', config as any, { appendLine: () => {} } as any);

    await client.start();

    // Tools should be discovered
    assert.ok(client.tools.length >= 2, 'Expected at least 2 tools');

    const echo = await client.callTool('echo', { message: 'hello' });
    const echoText = (echo.content.find(c => c.type === 'text') as any).text;
    assert.strictEqual(echoText, 'Echo: hello');

    const sum = await client.callTool('sum', { a: 3, b: 4 });
    const sumText = (sum.content.find(c => c.type === 'text') as any).text;
    assert.strictEqual(sumText, '7');

    await client.stop();
  });

  test('websocket transport: discover tools and call echo', async () => {
    const tools = [
      { name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: { message: { type: 'string' } } } }
    ];

    const server = new WebSocket.Server({ port: 0 });
    const port = (server.address() as any).port;

    server.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.method === 'initialize') {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'mock-ws', version: '0.1' } } }));
        } else if (msg.method === 'tools/list') {
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools } }));
        } else if (msg.method === 'tools/call') {
          const text = String((msg.params?.arguments?.message) || '');
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `Echo: ${text}` }] } }));
        }
      });
    });

    const client = new McpClient('test-ws', { type: 'websocket', url: `ws://127.0.0.1:${port}` } as any, { appendLine: () => {} } as any);

    await client.start();

    // Wait for tools discovery (the client initializes on ws open)
    for (let i = 0; i < 20 && client.tools.length === 0; i++) {
      await timeout(50);
    }

    assert.ok(client.tools.length >= 1, 'Expected at least 1 tool for websocket');

    const res = await client.callTool('echo', { message: 'ws-hello' });
    const txt = (res.content.find(c => c.type === 'text') as any).text;
    assert.strictEqual(txt, 'Echo: ws-hello');

    await client.stop();
    server.close();
  });

  test('http transport: discover tools and call echo', async () => {
    const tools = [ { name: 'echo', description: 'Echo', inputSchema: { type: 'object' } } ];

    const server = http.createServer(async (req, res) => {
      if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
      let body = '';
      req.on('data', (c) => body += c);
      req.on('end', () => {
        try {
          const msg = JSON.parse(body);
          if (msg.method === 'initialize') {
            res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'mock-http', version: '0.1' } } }));
          } else if (msg.method === 'tools/list') {
            res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools } }));
          } else if (msg.method === 'tools/call') {
            const text = String((msg.params?.arguments?.message) || '');
            res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `Echo: ${text}` }] } }));
          } else {
            res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Unknown' } }));
          }
        } catch (e) {
          res.statusCode = 500; res.end('err');
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as any).port;

    const client = new McpClient('test-http', { type: 'http', url: `http://127.0.0.1:${port}` } as any, { appendLine: () => {} } as any);

    await client.start();

    // HTTP client does initialize/discover during start
    assert.ok(client.tools.length >= 1, 'Expected at least 1 tool for http');

    const res = await client.callTool('echo', { message: 'http-hello' });
    const txt = (res.content.find(c => c.type === 'text') as any).text;
    assert.strictEqual(txt, 'Echo: http-hello');

    await client.stop();
    server.close();
  });
});
