import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import {
    McpServerConfig,
    McpServerConfigExtended,
    McpServerType,
    JsonRpcRequest,
    JsonRpcResponse,
    InitializeParams,
    InitializeResult,
    ListToolsResult,
    McpTool,
    CallToolParams,
    CallToolResult
} from './types';
import * as http from 'http';
import * as https from 'https';
// Use require for ws to avoid needing dev-time types when not installed
const WsClient: any = require('ws');


const MCP_PROTOCOL_VERSION = '2024-11-05';

/**
 * Resolves VS Code-style placeholders in a string.
 * Supports: ${workspaceFolder}, ${workspaceFolderBasename}, ${userHome}, ${env:VAR_NAME}, etc.
 */
function resolvePlaceholders(value: string, workspaceFolder?: string): string {
    return value.replace(/\$\{([^}]+)\}/g, (match, placeholder: string) => {
        // Handle ${env:VAR_NAME}
        if (placeholder.startsWith('env:')) {
            const envVar = placeholder.substring(4);
            return process.env[envVar] || '';
        }

        switch (placeholder) {
            case 'workspaceFolder':
                return workspaceFolder || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
            case 'workspaceFolderBasename': {
                const folder = workspaceFolder || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
                return folder ? folder.split(/[\\/]/).pop() || '' : '';
            }
            case 'userHome':
                return process.env.HOME || process.env.USERPROFILE || '';
            case 'cwd':
                return process.cwd();
            case 'pathSeparator':
                return process.platform === 'win32' ? '\\' : '/';
            default:
                // Return original if placeholder is unknown
                return match;
        }
    });
}

/**
 * Resolves placeholders in all string values of an object (shallow).
 */
function resolveEnvPlaceholders(env: Record<string, string> | undefined, workspaceFolder?: string): Record<string, string> | undefined {
    if (!env) {
        return undefined;
    }
    const resolved: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
        resolved[key] = resolvePlaceholders(value, workspaceFolder);
    }
    return resolved;
}

/**
 * MCP Client that spawns and communicates with an MCP server via stdio JSON-RPC
 */
export class McpClient extends EventEmitter {
    private process: ChildProcess | null = null;
    private ws: any | null = null;
    private httpUrl: string | null = null;
    private requestId = 0;
    private pendingRequests = new Map<number | string, {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
    }>();
    private buffer = '';
    private serverInfo: InitializeResult | null = null;
    private _tools: McpTool[] = [];
    private outputChannel: vscode.OutputChannel;

    constructor(
        public readonly name: string,
        private readonly config: McpServerConfigExtended,
        outputChannel: vscode.OutputChannel
    ) {
        super();
        this.outputChannel = outputChannel;
    }

    get transport(): string {
        return this.config.type || 'stdio';
    }

    get url(): string | undefined {
        return this.config.url;
    }

    get tools(): McpTool[] {
        return this._tools;
    }

    get isConnected(): boolean {
        return this.process !== null && !this.process.killed;
    }

    async start(): Promise<void> {
        if (this.process) {
            return;
        }
        const type: McpServerType = this.config.type || 'stdio';

        // Get workspace folder for placeholder resolution
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

        if (type === 'stdio') {
            if (!this.config.command) {
                throw new Error('stdio transport requires a `command` in server config');
            }

            // Resolve placeholders in command, args, and env
            const command = resolvePlaceholders(this.config.command, workspaceFolder);
            const args = (this.config.args || []).map(arg => resolvePlaceholders(arg, workspaceFolder));
            const configEnv = resolveEnvPlaceholders(this.config.env, workspaceFolder);

            this.outputChannel.appendLine(`[${this.name}] Starting MCP server: ${command} ${args.join(' ')}`);

            const env = { ...process.env, ...configEnv };
            
            this.process = spawn(command, args, {
                env,
                stdio: ['pipe', 'pipe', 'pipe'],
                shell: true
            });

            this.process.stdout?.on('data', (data: Buffer) => {
                this.handleData(data.toString());
            });

            this.process.stderr?.on('data', (data: Buffer) => {
                this.outputChannel.appendLine(`[${this.name}] stderr: ${data.toString()}`);
            });

            this.process.on('error', (err) => {
                this.outputChannel.appendLine(`[${this.name}] Process error: ${err.message}`);
                this.emit('error', err);
            });

            this.process.on('exit', (code, signal) => {
                this.outputChannel.appendLine(`[${this.name}] Process exited with code ${code}, signal ${signal}`);
                this.process = null;
                this.emit('exit', code, signal);
            });

            // Initialize the connection
            await this.initialize();
            
            // Discover tools
            await this.discoverTools();
        } else if (type === 'websocket') {
            if (!this.config.url) {
                throw new Error('WebSocket transport requires a `url` in server config');
            }

            const url = resolvePlaceholders(this.config.url, workspaceFolder);
            this.outputChannel.appendLine(`[${this.name}] Connecting via WebSocket to ${url}`);
            this.ws = new WsClient(url, { headers: this.config.headers });

            this.ws.on('open', async () => {
                this.outputChannel.appendLine(`[${this.name}] WebSocket connected`);
                try {
                    await this.initialize();
                    await this.discoverTools();
                } catch (err) {
                    this.outputChannel.appendLine(`[${this.name}] WebSocket initialization failed: ${(err as Error).message}`);
                }
            });

            this.ws.on('message', (data: string | Buffer) => {
                const text = typeof data === 'string' ? data : data.toString();
                try {
                    this.outputChannel.appendLine(`[${this.name}] <- ${text}`);
                    const message = JSON.parse(text) as JsonRpcResponse;
                    this.handleMessage(message);
                } catch (e) {
                    this.outputChannel.appendLine(`[${this.name}] Failed to parse WS message: ${text}`);
                }
            });

            this.ws.on('error', (err: Error) => {
                this.outputChannel.appendLine(`[${this.name}] WebSocket error: ${err.message}`);
                this.emit('error', err);
            });

            this.ws.on('close', (code: number, reason: Buffer) => {
                this.outputChannel.appendLine(`[${this.name}] WebSocket closed: ${code} ${reason}`);
                this.ws = null;
                this.emit('exit', code, reason.toString());
            });
        } else if (type === 'http') {
            if (!this.config.url) {
                throw new Error('HTTP transport requires a `url` in server config');
            }

            this.httpUrl = resolvePlaceholders(this.config.url, workspaceFolder);
            this.outputChannel.appendLine(`[${this.name}] Using HTTP transport to ${this.httpUrl}`);

            // Test initialize via HTTP
            await this.initialize();
            await this.discoverTools();
        } else {
            throw new Error(`Unsupported MCP transport type: ${type}`);
        }
    }

    async stop(): Promise<void> {
        if (this.process) {
            this.process.kill();
            this.process = null;
        }
        if (this.ws) {
            try { this.ws.close(); } catch {}
            this.ws = null;
        }
        this.httpUrl = null;
        this._tools = [];
        this.serverInfo = null;
    }

    private async initialize(): Promise<void> {
        const params: InitializeParams = {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {
                roots: { listChanged: true }
            },
            clientInfo: {
                name: 'vscode-mcp-proxy',
                version: '0.0.1'
            }
        };

        this.serverInfo = await this.sendRequest<InitializeResult>('initialize', params);
        this.outputChannel.appendLine(`[${this.name}] Connected to ${this.serverInfo.serverInfo.name} v${this.serverInfo.serverInfo.version}`);

        // Send initialized notification
        await this.sendNotification('notifications/initialized', {});
    }

    private async discoverTools(): Promise<void> {
        const result = await this.sendRequest<ListToolsResult>('tools/list', {});
        this._tools = result.tools;
        this.outputChannel.appendLine(`[${this.name}] Discovered ${this._tools.length} tools: ${this._tools.map(t => t.name).join(', ')}`);
    }

    async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
        const params: CallToolParams = {
            name,
            arguments: args
        };
        return this.sendRequest<CallToolResult>('tools/call', params);
    }

    private sendRequest<T>(method: string, params: unknown): Promise<T> {
        const type: McpServerType = this.config.type || 'stdio';

        if (type === 'http') {
            // Send JSON-RPC over HTTP POST to this.httpUrl
            if (!this.httpUrl) {
                return Promise.reject(new Error('HTTP transport not configured'));
            }

            const id = ++this.requestId;
            const request: JsonRpcRequest = {
                jsonrpc: '2.0',
                id,
                method,
                params
            };

            return this.postJson(this.httpUrl, request).then((resp) => {
                if (resp.error) {
                    throw new Error(`${resp.error.message} (code: ${resp.error.code})`);
                }
                return resp.result as T;
            });
        }

        // For stdio and websocket, use persistent connection + pending requests
        return new Promise((resolve, reject) => {
            const id = ++this.requestId;
            const request: JsonRpcRequest = {
                jsonrpc: '2.0',
                id,
                method,
                params
            };

            this.pendingRequests.set(id, {
                resolve: resolve as (value: unknown) => void,
                reject
            });

            const message = JSON.stringify(request);

            const typeIsStdio = (this.config.type || 'stdio') === 'stdio';
            if (typeIsStdio) {
                if (!this.process?.stdin) {
                    this.pendingRequests.delete(id);
                    reject(new Error('MCP server not connected'));
                    return;
                }

                this.outputChannel.appendLine(`[${this.name}] -> ${message}`);
                this.process.stdin.write(message + '\n');
            } else {
                // WebSocket
                if (!this.ws || this.ws.readyState !== WsClient.OPEN) {
                    this.pendingRequests.delete(id);
                    reject(new Error('MCP WebSocket not connected'));
                    return;
                }

                this.outputChannel.appendLine(`[${this.name}] -> ${message}`);
                this.ws.send(message);
            }
        });
    }

    private async sendNotification(method: string, params: unknown): Promise<void> {
        const type: McpServerType = this.config.type || 'stdio';

        const notification = {
            jsonrpc: '2.0',
            method,
            params
        };

        const message = JSON.stringify(notification);

        if (type === 'http') {
            if (!this.httpUrl) {
                return;
            }
            try {
                await this.postJson(this.httpUrl, notification as any);
            } catch (e) {
                // Ignore notification errors
            }
            return;
        }

        if ((this.config.type || 'stdio') === 'stdio') {
            if (!this.process?.stdin) {
                return;
            }
            this.outputChannel.appendLine(`[${this.name}] -> ${message}`);
            this.process.stdin.write(message + '\n');
            return;
        }

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.outputChannel.appendLine(`[${this.name}] -> ${message}`);
            this.ws.send(message);
        }
    }

    private postJson(urlStr: string, body: unknown): Promise<JsonRpcResponse> {
        return new Promise((resolve, reject) => {
            try {
                const url = new URL(urlStr);
                const data = JSON.stringify(body);
                const opts: any = {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(data),
                        ...(this.config.headers || {})
                    }
                };

                const client = url.protocol === 'https:' ? https : http;
                const req = client.request(url, opts, (res) => {
                    let resp = '';
                    res.setEncoding('utf8');
                    res.on('data', (chunk) => resp += chunk);
                    res.on('end', () => {
                        try {
                            const parsed = JSON.parse(resp) as JsonRpcResponse;
                            resolve(parsed);
                        } catch (e) {
                            reject(new Error('Failed to parse HTTP JSON-RPC response'));
                        }
                    });
                });

                req.on('error', (err) => reject(err));
                req.write(data);
                req.end();
            } catch (e) {
                reject(e);
            }
        });
    }

    private handleData(data: string): void {
        this.buffer += data;

        // Try to parse complete JSON messages (newline-delimited)
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() || '';

        for (const line of lines) {
            if (line.trim()) {
                try {
                    this.outputChannel.appendLine(`[${this.name}] <- ${line}`);
                    const message = JSON.parse(line) as JsonRpcResponse;
                    this.handleMessage(message);
                } catch (e) {
                    this.outputChannel.appendLine(`[${this.name}] Failed to parse message: ${line}`);
                }
            }
        }
    }

    private handleMessage(message: JsonRpcResponse): void {
        if (message.id !== undefined) {
            const pending = this.pendingRequests.get(message.id);
            if (pending) {
                this.pendingRequests.delete(message.id);
                if (message.error) {
                    pending.reject(new Error(`${message.error.message} (code: ${message.error.code})`));
                } else {
                    pending.resolve(message.result);
                }
            }
        }
    }
}
