import * as vscode from 'vscode';
import { McpClient } from './mcpClient';
import { McpTool, CallToolResult, TextContent, ImageContent } from './types';

/**
 * Wraps an MCP tool as a VS Code Language Model Tool
 */
export class McpToolProvider implements vscode.LanguageModelTool<Record<string, unknown>> {
    constructor(
        private readonly client: McpClient,
        private readonly mcpTool: McpTool,
        private readonly outputChannel: vscode.OutputChannel
    ) {}

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<Record<string, unknown>>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        this.outputChannel.appendLine(`[${this.client.name}] Invoking tool ${this.mcpTool.name} with args: ${JSON.stringify(options.input)}`);

        try {
            const result = await this.client.callTool(this.mcpTool.name, options.input);
            return this.convertResult(result);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(`[${this.client.name}] Tool error: ${errorMessage}`);
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Error: ${errorMessage}`)
            ]);
        }
    }

    prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<Record<string, unknown>>,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.PreparedToolInvocation> {
        return {
            invocationMessage: `Running ${this.mcpTool.name} from ${this.client.name}...`
        };
    }

    private convertResult(result: CallToolResult): vscode.LanguageModelToolResult {
        const parts: (vscode.LanguageModelTextPart | vscode.LanguageModelPromptTsxPart)[] = [];

        for (const content of result.content) {
            if (content.type === 'text') {
                const textContent = content as TextContent;
                parts.push(new vscode.LanguageModelTextPart(textContent.text));
            } else if (content.type === 'image') {
                const imageContent = content as ImageContent;
                // For images, we return a description since LanguageModelToolResult doesn't directly support images
                parts.push(new vscode.LanguageModelTextPart(`[Image: ${imageContent.mimeType}]`));
            } else if (content.type === 'resource') {
                // Handle resource content
                const text = (content as { resource: { text?: string } }).resource.text;
                if (text) {
                    parts.push(new vscode.LanguageModelTextPart(text));
                }
            }
        }

        if (parts.length === 0) {
            parts.push(new vscode.LanguageModelTextPart('Tool completed successfully'));
        }

        return new vscode.LanguageModelToolResult(parts);
    }
}

/**
 * Manages registration of MCP tools as VS Code Language Model Tools
 */
export class ToolRegistry {
    private disposables: vscode.Disposable[] = [];
    private registeredTools = new Map<string, vscode.Disposable>();

    constructor(private readonly outputChannel: vscode.OutputChannel) {}

    /**
     * Register all tools from an MCP client
     */
    registerClientTools(client: McpClient): void {
        for (const tool of client.tools) {
            this.registerTool(client, tool);
        }
    }

    /**
     * Register a single MCP tool as a VS Code Language Model Tool
     */
    private registerTool(client: McpClient, tool: McpTool): void {
        // Create a unique tool name combining server name and tool name
        const toolName = `${client.name}_${tool.name}`;

        // Check if already registered
        if (this.registeredTools.has(toolName)) {
            this.outputChannel.appendLine(`Tool ${toolName} already registered, skipping`);
            return;
        }

        const provider = new McpToolProvider(client, tool, this.outputChannel);
        
        try {
            const disposable = vscode.lm.registerTool(toolName, provider);
            this.registeredTools.set(toolName, disposable);
            this.disposables.push(disposable);
            this.outputChannel.appendLine(`Registered tool: ${toolName}`);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(`Failed to register tool ${toolName}: ${errorMessage}`);
        }
    }

    /**
     * Unregister all tools from a specific client
     */
    unregisterClientTools(client: McpClient): void {
        for (const tool of client.tools) {
            const toolName = `${client.name}_${tool.name}`;
            const disposable = this.registeredTools.get(toolName);
            if (disposable) {
                disposable.dispose();
                this.registeredTools.delete(toolName);
                this.outputChannel.appendLine(`Unregistered tool: ${toolName}`);
            }
        }
    }

    /**
     * Dispose all registered tools
     */
    dispose(): void {
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables = [];
        this.registeredTools.clear();
    }
}
