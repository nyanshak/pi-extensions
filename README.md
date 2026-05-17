# pi-extensions

Monorepo for [pi](https://github.com/earendal-team/pi-coding-agent) editor extensions.

## Extensions

### [pi-acp](./pi-acp/)

ACP (Agent Client Protocol) extension for pi - enables Zed IDE integration via ACP protocol.

**Features:**
- Full ACP protocol implementation per [spec](https://agentclientprotocol.com/)
- Session management (create, prompt, end)
- Real-time streaming (agent_message_chunk, tool_call_update, etc.)
- Zed integration with message formatting

**Tests:** 24 passing  
**Location:** `pi-acp/src/index.ts`

**Documentation:** [pi-acp/README.md](./pi-acp/README.md)

### [pi-web](./pi-web/)

WebSocket server extension for pi - enables remote connections via WebSocket.

**Features:**
- HTTP server with WebSocket upgrade
- Optional password authentication (Bearer header or query param)
- `/web` slash command for interactive server start
- ACP method handlers

**Tests:** 52 passing  
**Location:** `pi-web/src/index.ts`

**Documentation:** [pi-web/README.md](./pi-web/README.md) (or [PLAN.md](./pi-web/PLAN.md))

## Usage

Add extensions to your `~/.config/pi/package.json`:

```json
{
  "pi": {
    "extensions": [
      "path/to/pi-extensions/pi-acp/src/index.ts",
      "path/to/pi-extensions/pi-web/src/index.ts"
    ]
  }
}
```

### Running Extensions

**pi-acp:**
```bash
PI_ACP=1 pi
# or
pi --acp
```

**pi-web:**
```bash
pi-web --web --web-port 8080 --web-password secret
# or from within pi:
/web
```

## Development

Each extension has its own documentation:

- [pi-acp README](./pi-acp/README.md)
- [pi-web PLAN.md](./pi-web/PLAN.md)

## Contributing

Contributions welcome! Please see individual extension docs for contribution guidelines.
