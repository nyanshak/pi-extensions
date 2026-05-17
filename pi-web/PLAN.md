# pi-web: WebSocket Server for pi

Web interface to pi via WebSocket server.

## Status: Complete

All planned features have been implemented with tests.

## Features

### Flags
- `--web` - Start web server mode
- `--web-port <port>` - Port to listen on (default: random)
- `--web-host <hostname>` - Host to bind to (default: 127.0.0.1)
- `--web-password <password>` - Optional password auth

### Slash Command
- `/web` - Start web server from within pi
  - Prompts for port (default: empty for random)
  - Prompts for host (default: 127.0.0.1)
  - Prompts for password (optional)
  - Outputs URL when started
  - Clean shutdown on /exit or Ctrl+C

### Behavior
- **Does NOT open browser** - just listens and outputs URL
- Output: `Web server running at ws://127.0.0.1:38472`
- On Ctrl+C or `/exit`, stop server

### Auth (optional)
- If password set, require `password` query param or `Authorization` header
- Auth failure returns HTTP 401

### Protocol
- WebSocket upgrade from HTTP
- All ACP messages over WebSocket (JSON-RPC 2.0)
- Real-time streaming: agent_message_chunk, tool_call_update, etc.

## Architecture

```
┌─────────────────────────────────────────┐
│              HTTP Server                │
│  ┌─────────────────────────────────┐   │
│  │     WebSocket Upgrade Handler    │   │
│  └─────────────────────────────────┘   │
│              ↓                         │
│  ┌─────────────────────────────────┐   │
│  │   WebSocket Transport (ACP)     │   │
│  │   - session_new                │   │
│  │   - session_prompt              │   │
│  │   - session_end                 │   │
│  │   - session/list               │   │
│  │   - session/update_metadata     │   │
│  │   - session/cancel              │   │
│  │   - capabilities               │   │
│  └─────────────────────────────────┘   │
└─────────────────────────────────────────┘
```

## Files

```
pi-web/
├── src/
│   ├── index.ts          # Extension entry, CLI, /web command
│   ├── server.ts         # HTTP + WebSocket server
│   ├── auth.ts          # Password authentication
│   └── websocket.ts      # WebSocket transport for JSON-RPC
├── test/
│   ├── test.ts          # Simple test framework
│   ├── auth.test.ts     # 14 tests
│   ├── server.test.ts   # 13 tests
│   ├── websocket.test.ts # 11 tests
│   └── acp.test.ts      # 10 tests
├── package.json
└── PLAN.md
```

## Tests: 52 passing

| Module | Tests |
|--------|-------|
| Auth Module | 14 |
| Server Module | 13 |
| WebSocket Transport | 11 |
| ACP Handler Tests | 10 |

## Usage

### As pi Extension

Add to `~/.config/pi/package.json`:
```json
{
  "pi": {
    "extensions": [
      "path/to/pi-web/src/index.ts"
    ]
  }
}
```

Then run `/web` in pi to start the server interactively.

### As Standalone CLI

```bash
# Start server on random port
pi-web --web

# Start on specific port
pi-web --web --web-port 8080

# Start with password auth
pi-web --web --web-password secret

# Bind to specific host
pi-web --web --web-host 0.0.0.0 --web-port 8080
```

### Connecting

Connect via WebSocket client:
```javascript
const ws = new WebSocket('ws://127.0.0.1:38472');
ws.send(JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'session_new',
  params: { model: 'claude-sonnet-4-20250514' }
}));
```

## ACP Methods

| Method | Description |
|--------|-------------|
| `session_new` | Create new session |
| `session_prompt` | Send prompt to session |
| `session_end` | End session |
| `session/list` | List sessions |
| `session/update_metadata` | Update session name |
| `session/cancel` | Cancel running request |
| `capabilities` | Get server capabilities |