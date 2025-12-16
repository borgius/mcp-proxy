import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import {
    McpServerConfig,
    JsonRpcRequest,
    JsonRpcResponse,
    InitializeParams,
    InitializeResult,
    ListToolsResult,
    McpTool,
    CallToolParams,
    CallToolResult
} from './types';

const MCP_PROTOCOL_VERSION = '2024-11-05';

/**
 * MCP Client that spawns and communicates with an MCP server via stdio JSON-RPC
 */
export class McpClient extends EventEmitter {
    private process: ChildProcess | null = null;
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
        private readonly config: McpServerConfig,
        outputChannel: vscode.OutputChannel
    ) {
        super();
        this.outputChannel = outputChannel;
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

        this.outputChannel.appendLine(`[${this.name}] Starting MCP server: ${this.config.command} ${(this.config.args || []).join(' ')}`);

        const env = { ...process.env, ...this.config.env };
        
        this.process = spawn(this.config.command, this.config.args || [], {
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
    }

    async stop(): Promise<void> {
        if (this.process) {
            this.process.kill();
            this.process = null;
        }
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
        this.sendNotification('notifications/initialized', {});
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
        return new Promise((resolve, reject) => {
            if (!this.process?.stdin) {
                reject(new Error('MCP server not connected'));
                return;
            }

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
            this.outputChannel.appendLine(`[${this.name}] -> ${message}`);
            this.process.stdin.write(message + '\n');
        });
    }

    private sendNotification(method: string, params: unknown): void {
        if (!this.process?.stdin) {
            return;
        }

        const notification = {
            jsonrpc: '2.0',
            method,
            params
        };

        const message = JSON.stringify(notification);
        this.outputChannel.appendLine(`[${this.name}] -> ${message}`);
        this.process.stdin.write(message + '\n');
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
