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

**Documentation:** [pi-acp/README.md](./pi-acp/README.md)

### [pi-webserver](./pi-webserver/)

Shared HTTP server for pi — single port, Basic auth, Bearer token API auth, event-bus mount system for other extensions.

**Features:**
- Single shared port (default 4100)
- Basic auth for page routes, Bearer token for API routes
- Cookie-based session auth for browser login
- Longest-prefix routing, built-in dashboard at `/`
- Event bus mounting — no import needed, extensions emit `web:mount` / `web:mount-api`

**Documentation:** [pi-webserver/README.md](./pi-webserver/README.md)

### [pi-web-dashboard](./pi-web-dashboard/)

Live agent dashboard with SSE streaming — watch agent activity in real-time and submit prompts from the browser.

**Features:**
- SSE feed of agent lifecycle events (start/end, turns, tool calls)
- Prompt submission + `/commands` routing from browser
- Rate-limited (10/min per IP)
- Depends on pi-webserver

**Documentation:** [pi-web-dashboard/README.md](./pi-web-dashboard/README.md)

## Usage

Add extensions to your `~/.config/pi/package.json`:

```json
{
  "pi": {
    "extensions": [
      "path/to/pi-extensions/pi-acp/src/index.ts"
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

## Development

Each extension has its own documentation:

- [pi-webserver README](./pi-webserver/README.md)
- [pi-web-dashboard README](./pi-web-dashboard/README.md)

## Contributing

Contributions welcome! Please see individual extension docs for contribution guidelines.
