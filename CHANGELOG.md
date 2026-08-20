# Changelog

## 0.0.2

- Added `room_wait` with bounded, race-safe long polling
- Added `room_list` with simple case-insensitive token discovery
- Added optional `room_join(createIfMissing=false)` typo protection
- Added participant status and `room_set_status`
- Added server-controlled message `origin`
- Added `GET /health` and active `ai-room status` diagnostics
- Documented persistent-workspace workflow, polling protocol, Plan Mode limits, and human approval boundaries
- Preserved all v0.0.1 MCP tools, required arguments, and response fields

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
