# MCP Proxy

This VS Code extension proxies one or more MCP (Model Context Protocol) servers into VS Code’s **Language Model Tools** API.

Why?

- If, for any reason, your VS Code **Chat / MCP access** is set to **none** (and you’re allowed to change it), this extension lets you expose MCP servers defined in a workspace config file as callable tools.
- The extension can either spawn MCP servers locally (stdio JSON-RPC) or connect to remote MCP servers via WebSocket or HTTP JSON-RPC, depending on how you configure each server.

## What it provides

- **`mcp-list`**: lists all loaded MCP servers and their tools.
- **`mcp-call`**: calls a specific MCP tool on a specific server.

These are registered through VS Code’s Language Model Tools API (`vscode.lm.registerTool`).

## Configuration

By default, the extension loads MCP server configs from:

- `.vscode/mcp.json` (per workspace folder)

You can point it at a different file via settings:

- `mcpProxy.configFile` (default: `.vscode/mcp.json`)

Notes:

- Relative paths are resolved from each workspace folder.
- If you set an **absolute** path, the extension will still load it, but auto-reload on file changes may be disabled (because VS Code file watchers are workspace-relative).

### Example config file

Create the file (default) `.vscode/mcp.json`:

```jsonc
{
	"servers": {
		"myProcessServer": {
			"type": "stdio",
			"command": "node",
			"args": ["/absolute/or/workspace-relative/path/to/server.js"],
			"env": {
				"SOME_VAR": "value"
			}
		},
		"myWebsocketServer": {
			"type": "websocket",
			"url": "ws://localhost:12345"
		},
		"myHttpServer": {
			"type": "http",
			"url": "https://example.com/mcp"
		}
	}
}
```

## Commands

- **MCP Proxy: Refresh Servers** (`mcp-proxy.refresh`) reloads config and restarts MCP server processes.
- **MCP Proxy: Show Output** (`mcp-proxy.showOutput`) shows the extension output channel.

## Requirements / permissions

- This extension is only useful when VS Code can run Language Model Tools and you have permission to enable the relevant Chat/MCP access in your environment.
- MCP servers are processes you run locally from your configuration file; treat the config as code and only use servers you trust.
