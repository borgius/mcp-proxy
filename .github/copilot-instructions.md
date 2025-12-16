# MCP Proxy Extension

This VS Code extension acts as a proxy for MCP (Model Context Protocol) servers, exposing their tools as native VS Code Language Model Tools.

## Architecture

- Reads MCP server configurations from `.vscode/mcp.json` in workspaces
- Spawns MCP server processes and communicates via stdio JSON-RPC
- Registers MCP tools as `vscode.lm.tools.Tool` instances
- Forwards tool invocations to the MCP servers

## Key Files

- `src/extension.ts` - Extension entry point, activation/deactivation
- `src/mcpClient.ts` - MCP client for spawning servers and JSON-RPC communication
- `src/toolProvider.ts` - Registers MCP tools as VS Code Language Model Tools
- `src/types.ts` - TypeScript types for MCP protocol messages

## Development

```bash
npm install
npm run compile
# Press F5 to launch Extension Development Host
```
