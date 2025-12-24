import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { McpClient } from './mcpClient';
import type { McpConfig } from './types';

let outputChannel: vscode.OutputChannel;
const mcpClients = new Map<string, McpClient>();
let mcpConfigWatchers: vscode.FileSystemWatcher[] = [];

// Input types for our tools
interface McpCallInput {
    server: string;
    tool: string;
    arguments?: Record<string, unknown>;
}

type McpListInput = Record<string, never>;

export async function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('MCP Proxy', { log: false });
    // Note: Output channel created with log: false to preserve raw output with ANSI colors
    outputChannel.appendLine('MCP Proxy extension activating...');

    // Register the mcp-call tool
    const mcpCallTool = vscode.lm.registerTool<McpCallInput>('mcp-call', {
        async invoke(options, _token) {
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
        prepareInvocation(options, _token) {
            return {
                invocationMessage: `Calling MCP tool ${options.input.tool} on ${options.input.server}...`
            };
        }
    });

    // Register the mcp-list tool
    const mcpListTool = vscode.lm.registerTool<McpListInput>('mcp-list', {
        async invoke(_options, _token) {
            outputChannel.appendLine('mcp-list: listing all servers and tools');

            if (mcpClients.size === 0) {
                return new vscode.LanguageModelToolResult([
                    new vscode.LanguageModelTextPart(
                        "No MCP servers are currently loaded. Ensure your MCP config file exists (default: .vscode/mcp.json) or set 'mcpProxy.configFile' to point at a different file."
                    )
                ]);
            }

            const lines: string[] = ['# Available MCP Servers and Tools\n'];
            
            for (const [name, client] of mcpClients) {
                lines.push(`## Server: ${name}`);
                lines.push(`Status: ${client.isConnected ? 'Connected' : 'Disconnected'}`);
                lines.push(`Transport: ${('transport' in client) ? (client as any).transport + ((client as any).url ? ' (' + (client as any).url + ')' : '') : 'stdio'}`);
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
        prepareInvocation(_options, _token) {
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

    // Watch for MCP config changes (configurable)
    await setupMcpConfigWatchers(context);

    // React to configuration changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async (e) => {
            if (e.affectsConfiguration('mcpProxy.configFile')) {
                outputChannel.appendLine("mcpProxy.configFile changed; updating watchers and refreshing servers");
                await setupMcpConfigWatchers(context);
                await refreshMcpServers();
            }
        })
    );

    // Initial load
    await refreshMcpServers();

    outputChannel.appendLine('MCP Proxy extension activated');
}

function getConfiguredMcpConfigFile(): string {
    const config = vscode.workspace.getConfiguration('mcpProxy');
    const raw = config.get<string>('configFile', '.vscode/mcp.json');
    return (raw || '.vscode/mcp.json').trim();
}

function normalizeRelativeConfigPath(configFile: string): string {
    let rel = configFile.trim();
    if (rel.startsWith('./')) {
        rel = rel.slice(2);
    }
    while (rel.startsWith('/')) {
        rel = rel.slice(1);
    }
    return rel;
}

function disposeMcpConfigWatchers(): void {
    for (const watcher of mcpConfigWatchers) {
        try {
            watcher.dispose();
        } catch {
            // ignore
        }
    }
    mcpConfigWatchers = [];
}

async function setupMcpConfigWatchers(context: vscode.ExtensionContext): Promise<void> {
    disposeMcpConfigWatchers();

    const configFile = getConfiguredMcpConfigFile();
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return;
    }

    if (path.isAbsolute(configFile)) {
        // FileSystemWatcher patterns are workspace-relative; skip watching absolute paths.
        outputChannel.appendLine(`Configured MCP config file is absolute; auto-reload disabled: ${configFile}`);
        return;
    }

    const rel = normalizeRelativeConfigPath(configFile);
    for (const folder of workspaceFolders) {
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, rel));
        watcher.onDidChange(() => refreshMcpServers());
        watcher.onDidCreate(() => refreshMcpServers());
        watcher.onDidDelete(() => refreshMcpServers());
        mcpConfigWatchers.push(watcher);
        context.subscriptions.push(watcher);
    }
}

async function refreshMcpServers(): Promise<void> {
    outputChannel.appendLine('Refreshing MCP servers...');

    // Stop all existing clients
    for (const [name, client] of mcpClients) {
        await client.stop();
        outputChannel.appendLine(`Stopped MCP server: ${name}`);
    }
    mcpClients.clear();

    // Find MCP config files in workspaces
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        outputChannel.appendLine('No workspace folders found');
        return;
    }

    const configuredConfigFile = getConfiguredMcpConfigFile();

    for (const folder of workspaceFolders) {
        const configPath = path.isAbsolute(configuredConfigFile)
            ? configuredConfigFile
            : path.join(folder.uri.fsPath, normalizeRelativeConfigPath(configuredConfigFile));

        if (fs.existsSync(configPath)) {
            outputChannel.appendLine(`Found MCP config in ${folder.name}: ${configPath}`);
            await loadMcpConfig(configPath, folder);
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

async function loadMcpConfig(configPath: string, _folder: vscode.WorkspaceFolder): Promise<void> {
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
