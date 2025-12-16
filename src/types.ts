/**
 * Types for MCP (Model Context Protocol) messages
 */

// JSON-RPC base types
export interface JsonRpcRequest {
    jsonrpc: '2.0';
    id: number | string;
    method: string;
    params?: unknown;
}

export interface JsonRpcResponse {
    jsonrpc: '2.0';
    id: number | string;
    result?: unknown;
    error?: JsonRpcError;
}

export interface JsonRpcError {
    code: number;
    message: string;
    data?: unknown;
}

// MCP Server Configuration (from .vscode/mcp.json)
export interface McpConfig {
    servers: Record<string, McpServerConfig>;
}

export interface McpServerConfig {
    command: string;
    args?: string[];
    env?: Record<string, string>;
}

// MCP Protocol Messages
export interface InitializeParams {
    protocolVersion: string;
    capabilities: ClientCapabilities;
    clientInfo: {
        name: string;
        version: string;
    };
}

export interface ClientCapabilities {
    roots?: {
        listChanged?: boolean;
    };
    sampling?: Record<string, never>;
}

export interface InitializeResult {
    protocolVersion: string;
    capabilities: ServerCapabilities;
    serverInfo: {
        name: string;
        version: string;
    };
}

export interface ServerCapabilities {
    tools?: {
        listChanged?: boolean;
    };
    resources?: {
        subscribe?: boolean;
        listChanged?: boolean;
    };
    prompts?: {
        listChanged?: boolean;
    };
}

// MCP Tool Types
export interface McpTool {
    name: string;
    description?: string;
    inputSchema: {
        type: 'object';
        properties?: Record<string, JsonSchema>;
        required?: string[];
    };
}

export interface JsonSchema {
    type?: string;
    description?: string;
    properties?: Record<string, JsonSchema>;
    items?: JsonSchema;
    required?: string[];
    enum?: unknown[];
    default?: unknown;
    [key: string]: unknown;
}

export interface ListToolsResult {
    tools: McpTool[];
}

export interface CallToolParams {
    name: string;
    arguments?: Record<string, unknown>;
}

export interface CallToolResult {
    content: ToolContent[];
    isError?: boolean;
}

export type ToolContent = TextContent | ImageContent | ResourceContent;

export interface TextContent {
    type: 'text';
    text: string;
}

export interface ImageContent {
    type: 'image';
    data: string;
    mimeType: string;
}

export interface ResourceContent {
    type: 'resource';
    resource: {
        uri: string;
        mimeType?: string;
        text?: string;
        blob?: string;
    };
}
