# Changelog

## 0.0.1

Initial MVP.

- `room_join`
- `room_send`
- `room_listen`
- `room_history`
- `room_who`
- `room_leave`
- SQLite storage (WAL mode), persistent across restarts
- Independent read cursor per agent
- MCP server over Streamable HTTP, bound to `127.0.0.1`
- CLI: `ai-room serve` / `status` / `rooms` / `messages` / `who`
- Validated live with Claude Code, OpenAI Codex CLI, and Gemini/AGY
