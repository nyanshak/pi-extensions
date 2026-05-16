# pi-acp

ACP (Agent Client Protocol) support for pi-coding-agent.

## Overview

This extension enables pi to act as an ACP-compatible agent that can be controlled by ACP clients like Zed, VS Code, or other editors that support the Agent Client Protocol.

## What is ACP?

ACP (Agent Client Protocol) is a JSON-RPC 2.0 based protocol for communication between AI coding agents and their clients (typically IDEs/editors). It was originally developed by Zed and is now an open specification.

**Protocol Reference:** https://agentclientprotocol.com/

## Features

- **ACP Transport**: Communication over stdio using JSON-RPC 2.0
- **Session Management**: Create, manage, and close ACP sessions
- **Message Streaming**: Real-time updates via `session/update` notifications
- **Tool Calls**: Execute pi tools through ACP requests
- **Slash Commands**: Available commands exposed to ACP clients
- **Mode Support**: `readOnly`, `auto`, and `fullAccess` session modes

## ACP Methods Implemented

### Agent Methods (Baseline)
- [x] `initialize` - Negotiate protocol version and capabilities
- [x] `authenticate` - Authentication (optional, no-op by default)
- [x] `session/new` - Create a new session
- [x] `session/prompt` - Send user prompts to the agent

### Agent Methods (Optional)
- [x] `session/load` - Resume existing sessions
- [x] `session/set_mode` - Switch session modes
- [x] `session/close` - Close an active session

### Agent Notifications
- [x] `session/update` - Stream updates to the client
- [x] `session/cancel` - Cancel ongoing operations

## Usage

### Running pi in ACP Mode

```bash
# Enable ACP mode via environment variable
PI_ACP=1 pi

# Or via command line flag
pi --acp
```

### Zed Configuration

Add pi as a custom agent in your Zed settings:

```json
{
  "agent_servers": {
    "pi": {
      "command": "pi",
      "args": ["--acp"],
      "env": {}
    }
  }
}
```

### VS Code Configuration

Similar configuration for VS Code extensions that support ACP agents.

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PI_ACP` | Enable ACP mode | `0` (disabled) |

### ACP Capabilities

The extension advertises the following capabilities:

```json
{
  "loadSession": true,
  "sessionCapabilities": {
    "close": true,
    "resume": true
  },
  "promptCapabilities": {
    "audio": false,
    "image": true,
    "embeddedContext": false
  },
  "mcpCapabilities": {
    "http": false,
    "sse": false
  }
}
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      ACP Client (Zed, etc.)                   │
└───────────────────────────┬─────────────────────────────────┘
                            │ JSON-RPC over stdio
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                   AcpStdioTransport                         │
│  - Reads JSON-RPC requests from stdin                      │
│  - Writes JSON-RPC responses to stdout                      │
└───────────────────────────┬─────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                  AcpProtocolHandler                         │
│  - Route messages to appropriate handlers                     │
│  - Manage ACP sessions via AcpSessionManager                 │
│  - Coordinate with pi ExtensionAPI                          │
└───────────────────────────┬─────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                     pi ExtensionAPI                          │
│  - Register tools, commands, events                         │
│  - Send/receive messages                                    │
│  - Session management                                       │
└─────────────────────────────────────────────────────────────┘
```

## Protocol Flow

```
1. Client → Agent: initialize
   ← Agent: InitializeResponse (capabilities, protocol version)

2. Client → Agent: session/new
   ← Agent: SessionNewResponse (sessionId, available commands)

3. Client → Agent: session/prompt
   → Agent: session/update (streaming message chunks, tool calls)
   → Agent: session/update (completion)
   ← Agent: SessionPromptResponse (final message, stop reason)
```

## Installation

### Option 1: Copy to extensions directory

```bash
# Copy the extension
cp -r ~/src/github.com/nyanshak/pi-acp ~/.pi/agent/extensions/pi-acp
```

### Option 2: Install via git

Add to your `settings.json`:

```json
{
  "extensions": [
    "git:github.com/nyanshak/pi-acp"
  ]
}
```

## Reference Implementations

- [goose](https://goose-docs.ai/docs/guides/acp-clients) - Goose CLI ACP implementation
- [calude-code-acp](https://github.com/zed-industries/calude-code-acp) - Claude Code ACP implementation
- [codex-acp](https://github.com/cola-io/codex-acp) - Codex ACP implementation

## License

MIT