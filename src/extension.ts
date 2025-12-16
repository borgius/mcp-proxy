import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { McpClient } from './mcpClient';
import { McpConfig } from './types';

let outputChannel: vscode.OutputChannel;
const mcpClients = new Map<string, McpClient>();

// Input types for our tools
interface McpCallInput {
    server: string;
    tool: string;
    arguments?: Record<string, unknown>;
}

interface McpListInput {
    // No input required
}

export async function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('MCP Proxy');
    outputChannel.appendLine('MCP Proxy extension activating...');

    // Register the mcp-call tool
    const mcpCallTool = vscode.lm.registerTool<McpCallInput>('mcp-call', {
        async invoke(options, token) {
            const { server, tool, arguments: args } = options.input;
            outputChannel.appendLine(`mcp-call: server=${server}, tool=${tool}, args=${JSON.stringify(args)}`);

            const client = mcpClients.get(server);
            if (!client) {
                const available = Array.from(mcpClients.keys()).join(', ') || 'none';
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(`Error: MCP server '${server}' not found. Available servers: ${available}`)
                ]);
            }

            if (!client.isConnected) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(`Error: MCP server '${server}' is not connected`)
                ]);
            }

            try {
                const result = await client.callTool(tool, args || {});
                const textParts = result.content
                    .filter(c => c.type === 'text')
                    .map(c => new vscode.LanguageModelTextPart((c as { text: string }).text));
                
                if (textParts.length === 0) {
                    textParts.push(new vscode.LanguageModelTextPart('Tool completed successfully'));
                }
                
                return new vscode.LanguageModelToolResult(textParts);
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(`Error calling tool: ${msg}`)
                ]);
            }
        },
        prepareInvocation(options, token) {
            return {
                invocationMessage: `Calling MCP tool ${options.input.tool} on ${options.input.server}...`
            };
        }
    });

    // Register the mcp-list tool
    const mcpListTool = vscode.lm.registerTool<McpListInput>('mcp-list', {
        async invoke(options, token) {
            outputChannel.appendLine('mcp-list: listing all servers and tools');

            if (mcpClients.size === 0) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart('No MCP servers are currently loaded. Make sure you have a .vscode/mcp.json file in your workspace.')
                ]);
            }

            const lines: string[] = ['# Available MCP Servers and Tools\n'];
            
            for (const [name, client] of mcpClients) {
                lines.push(`## Server: ${name}`);
                lines.push(`Status: ${client.isConnected ? 'Connected' : 'Disconnected'}`);
                lines.push(`Tools:`);
                
                for (const tool of client.tools) {
                    lines.push(`- **${tool.name}**: ${tool.description || 'No description'}`);
                    if (tool.inputSchema?.properties) {
                        const props = Object.keys(tool.inputSchema.properties).join(', ');
                        lines.push(`  Parameters: ${props}`);
                    }
                }
                lines.push('');
            }

            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(lines.join('\n'))
            ]);
        },
        prepareInvocation(options, token) {
            return {
                invocationMessage: 'Listing MCP servers and tools...'
            };
        }
    });

    context.subscriptions.push(mcpCallTool, mcpListTool);

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('mcp-proxy.refresh', () => refreshMcpServers()),
        vscode.commands.registerCommand('mcp-proxy.showOutput', () => outputChannel.show())
    );

    // Watch for mcp.json changes
    const mcpJsonWatcher = vscode.workspace.createFileSystemWatcher('**/.vscode/mcp.json');
    mcpJsonWatcher.onDidChange(() => refreshMcpServers());
    mcpJsonWatcher.onDidCreate(() => refreshMcpServers());
    mcpJsonWatcher.onDidDelete(() => refreshMcpServers());
    context.subscriptions.push(mcpJsonWatcher);

    // Initial load
    await refreshMcpServers();

    outputChannel.appendLine('MCP Proxy extension activated');
}

async function refreshMcpServers(): Promise<void> {
    outputChannel.appendLine('Refreshing MCP servers...');

    // Stop all existing clients
    for (const [name, client] of mcpClients) {
        await client.stop();
        outputChannel.appendLine(`Stopped MCP server: ${name}`);
    }
    mcpClients.clear();

    // Find all mcp.json files in workspaces
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        outputChannel.appendLine('No workspace folders found');
        return;
    }

    for (const folder of workspaceFolders) {
        const mcpJsonPath = path.join(folder.uri.fsPath, '.vscode', 'mcp.json');
        
        if (fs.existsSync(mcpJsonPath)) {
            outputChannel.appendLine(`Found mcp.json in ${folder.name}`);
            await loadMcpConfig(mcpJsonPath, folder);
        }
    }

    // Show status
    const serverCount = mcpClients.size;
    let toolCount = 0;
    for (const client of mcpClients.values()) {
        toolCount += client.tools.length;
    }
    
    if (serverCount > 0) {
        vscode.window.showInformationMessage(
            `MCP Proxy: Loaded ${serverCount} server(s) with ${toolCount} tool(s)`
        );
    }
}

async function loadMcpConfig(configPath: string, folder: vscode.WorkspaceFolder): Promise<void> {
    try {
        const content = fs.readFileSync(configPath, 'utf-8');
        // Remove comments from JSON (simple implementation for // comments)
        const jsonContent = content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
        const config: McpConfig = JSON.parse(jsonContent);

        if (!config.servers) {
            outputChannel.appendLine(`No servers defined in ${configPath}`);
            return;
        }

        for (const [name, serverConfig] of Object.entries(config.servers)) {
            outputChannel.appendLine(`Starting MCP server: ${name}`);

            const client = new McpClient(name, serverConfig, outputChannel);
            
            try {
                await client.start();
                mcpClients.set(name, client);

                // Handle client exit
                client.on('exit', () => {
                    outputChannel.appendLine(`MCP server ${name} exited`);
                    mcpClients.delete(name);
                });

            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                outputChannel.appendLine(`Failed to start MCP server ${name}: ${errorMessage}`);
                vscode.window.showErrorMessage(`Failed to start MCP server ${name}: ${errorMessage}`);
            }
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        outputChannel.appendLine(`Failed to load ${configPath}: ${errorMessage}`);
    }
}

export async function deactivate(): Promise<void> {
    outputChannel.appendLine('MCP Proxy extension deactivating...');

    // Stop all clients
    for (const [name, client] of mcpClients) {
        await client.stop();
        outputChannel.appendLine(`Stopped MCP server: ${name}`);
    }
    mcpClients.clear();

    outputChannel.appendLine('MCP Proxy extension deactivated');
}
