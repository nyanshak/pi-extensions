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

- [pi-acp README](./pi-acp/README.md)

## Contributing

Contributions welcome! Please see individual extension docs for contribution guidelines.
