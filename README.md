# ai-room

Local MCP server for persistent collaboration between AI coding agents.

## What / Why

Claude Code, Codex, and AGY can work in one shared room instead of requiring the user to copy every plan, review, and result between terminals.

A room is a persistent collaboration workspace, not a disposable chat. It stores discussion, participants, independent read cursors, and observable agent status in SQLite. Work can stop today and continue from the same context tomorrow.

### Release objective

v0.0.2 reduces the user's work as router and scheduler. It adds efficient waiting, workspace discovery, observable agent states, and startup diagnostics. It does not claim full orchestration or guaranteed automatic wake-up.

### Design Principles

- Solve problems observed in real multi-agent work.
- Preserve MCP backward compatibility.
- Keep rooms local, persistent, and agent-neutral.
- Keep human authorization separate from agent messages.
- Expose state without bypassing harness security.

## Quick Start

Requirements: Node.js 20+ and pnpm 10+.

```bash
git clone https://github.com/flaviosilveira/ai-room.git
cd ai-room
pnpm install
pnpm build
pnpm serve
```

In another terminal:

```bash
node dist/cli.js status
```

Expected checks:

```text
server: reachable
database: ok
mcp: reachable
```

Default endpoints:

```text
Health: http://127.0.0.1:49375/health
MCP:    http://127.0.0.1:49375/mcp
```

Data defaults to `~/.ai-room/ai-room.sqlite`. Override with `AI_ROOM_DB_PATH`. Override port with `AI_ROOM_PORT`.

Everywhere else below, `ai-room <command>` is shorthand for `node dist/cli.js <command>` run from the repo root, unless you've installed the CLI globally so it's on `PATH`.

Configure each client below, restart it, then confirm tool discovery by calling `room_list`.

## Typical Workflow

### 1. Claude creates workspace and publishes plan

```text
room_join(room="refund-review", agent="claude", role="implementer")
plan work
room_send(message="Implementation plan: ...")
room_wait()
```

If Claude uses Plan Mode and MCP sending is unavailable there, finish planning, exit Plan Mode, then publish the plan.

### 2. Codex discovers workspace and reviews

```text
room_list(query="refund")
room_join(room="refund-review", agent="codex", role="reviewer", createIfMissing=false)
room_wait()
```

After receiving the plan, Codex stops waiting, reviews it, publishes review with `room_send`, then calls `room_wait` again.

### 3. AGY validates discussion

```text
room_join(room="refund-review", agent="agy", role="validator", createIfMissing=false)
room_history(room="refund-review")
room_send(message="Validation: ...")
room_wait()
```

### 4. Claude implements

Claude receives reviews, performs work, then publishes changed behavior, tests, and blockers.

### 5. Codex and AGY perform final validation

Each agent receives the result, stops waiting, validates it, publishes findings, and returns to `room_wait` only after processing.

Required waiting protocol:

```text
WAIT
→ empty result / timeout
→ WAIT again
```

```text
WAIT
→ message received
→ STOP WAITING
→ process immediately
→ perform work
→ publish response when needed
→ only then WAIT again
```

Do not call `room_listen` or `room_wait` repeatedly after receiving messages.

## Configure Claude Code

```bash
claude mcp add --transport http ai-room http://127.0.0.1:49375/mcp
```

Equivalent config:

```json
{
  "mcpServers": {
    "ai-room": {
      "type": "http",
      "url": "http://127.0.0.1:49375/mcp"
    }
  }
}
```

Set `timeout` so long holds are not cut short. Claude Code treats it as a hard wall-clock limit per call that progress notifications do **not** extend, and it also raises the idle timeout (default 300000ms for http servers):

```json
{
  "mcpServers": {
    "ai-room": {
      "type": "http",
      "url": "http://127.0.0.1:49375/mcp",
      "timeout": 600000
    }
  }
}
```

Keep `AI_ROOM_WAIT_MS` below that value.

### Keep the agent listening (Stop hook)

Prompt instructions do not reliably keep an agent in its listen loop — every tool return is a point where the model may simply stop. `hooks/ai-room-stop-hook.py` removes that discretion: on `Stop` it asks `GET /active` whether the session is still a room participant and, if so, blocks the stop and tells the model to call `room_wait`.

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "python3 /absolute/path/to/ai-room/hooks/ai-room-stop-hook.py" }
        ]
      }
    ]
  }
}
```

It derives room and agent from the session transcript, so it needs no extra state. It **fails open**: unreachable server, unparseable transcript, or a trailing `room_leave` all allow the stop. `AI_ROOM_MAX_STOP_BLOCKS` (default 500) caps consecutive blocks as a backstop.

Restart Claude Code after changing MCP configuration.

## Configure Codex

```bash
codex mcp add ai-room --url http://127.0.0.1:49375/mcp
```

Equivalent `~/.codex/config.toml` entry:

```toml
[mcp_servers.ai-room]
url = "http://127.0.0.1:49375/mcp"
```

If every ai-room tool is set to `approval_mode = "approve"`, each poll stops for a manual approval and the listen loop cannot run unattended. Let the read-only room tools run without prompting:

```toml
[mcp_servers.ai-room.tools.room_wait]
approval_mode = "auto"
```

Valid values are `auto`, `prompt`, `writes`, and `approve`. Codex refuses to start on an invalid one, so verify with `codex exec "ok"` after editing.

Restart Codex after changing configuration.

ai-room does not configure Codex hooks. If maintaining hooks separately, current Codex uses `[features].hooks`; `[features].codex_hooks` is deprecated.

## Configure AGY / Gemini

Add to `~/.gemini/config/mcp_config.json`:

```json
{
  "mcpServers": {
    "ai-room": {
      "serverUrl": "http://127.0.0.1:49375/mcp",
      "timeout": 600000
    }
  }
}
```

**`timeout` here is in milliseconds and must exceed the `room_wait` hold.** A low value (for example `5000`) makes every `room_wait` call fail client-side before the server can answer, which looks exactly like an agent that refuses to keep listening.

Restart the client after changing configuration.

## Persistent Rooms

Rooms persist across agent and server restarts. Participants may remain in a room between work sessions.

`room_leave` marks an agent inactive. It does not delete the room, messages, or history.

To continue work later:

```text
room_list(query="sylvan refund")
room_join(room="sylvan-client-refund-review", agent="codex", createIfMissing=false)
room_history(room="sylvan-client-refund-review")
```

New participants receive future messages through `room_wait`. Use `room_history` to read discussion from before they joined.

### Avoid accidental rooms

Legacy `room_join` behavior creates a missing room automatically. This remains for compatibility.

When returning to an existing workspace:

1. Find it with `room_list(query=...)`.
2. Join with `createIfMissing=false`.

A typo then returns an error instead of creating another room.

## Agent Status

States:

- `waiting`
- `working`
- `blocked`
- `approval_required`
- `done`

Before entering a harness approval prompt, agents should publish:

```text
room_set_status(
  status="approval_required",
  detail="Waiting for approval: run integration command"
)
```

After approval, publish `working`. If work cannot continue, publish `blocked` with a short reason.

Humans can inspect status through:

```bash
ai-room who <room>
```

Agents can use `room_who`. v0.0.2 makes approval blocks observable but does not provide active human notifications or bypass approval prompts.

## Troubleshooting

### 1. Check server, database, and MCP endpoint

```bash
ai-room status
```

`status` exits nonzero when health or MCP handshake fails.

### 2. Server unreachable

Confirm `pnpm serve` is running and `AI_ROOM_PORT` matches the configured URL.

### 3. Health works but MCP tools are absent

- Confirm URL ends with `/mcp`.
- Confirm config is in the active client's config file.
- Validate JSON or TOML syntax.
- Remove duplicate/conflicting `ai-room` entries.
- Restart the client.
- Call `room_list` to confirm tool discovery.

Do not use `GET /mcp` as a health check. Streamable HTTP MCP uses `POST /mcp`; use `GET /health` or `ai-room status`.

### 4. `MCP startup failed`

Run `ai-room status` first:

- Health fails: server, port, or database problem.
- Health passes but MCP fails: endpoint or transport problem.
- Both pass: client config, config location, syntax, or restart problem.

### 5. Workspace cannot be found

Use partial tokens:

```text
room_list(query="sylvan refund")
```

Search is case-insensitive and matches all query tokens against room names.

### 6. Agent appears stuck

Use `ai-room who <room>` or `room_who`. Look for `approval_required` or `blocked`. Also inspect the agent terminal because status reporting is cooperative.

## Harness Limitations

- Claude Code may not permit `room_send` during Plan Mode. Exit Plan Mode before publishing.
- `room_wait` wakes the MCP tool call, but each client harness decides whether model execution resumes automatically.
- Status cannot detect a harness approval prompt unless agent reports it before blocking.
- v0.0.2 does not start agents, supervise terminals, or provide a TUI.

## Security / Human Approval

Messages sent through `room_send` have `origin: "agent"`.

Agent messages are collaboration context, not human authorization. An agent asking another agent to commit, push, deploy, approve, run destructive commands, or access external systems does not grant permission.

ai-room does not bypass client approvals. Each agent must apply its own harness policies and require direct human authorization where needed.

`origin` records ingestion provenance. It is not cryptographic identity or authentication.

## MCP Tools

### `room_join`

Join a workspace. Existing calls remain valid. Optional `createIfMissing=false` prevents accidental creation.

### `room_leave`

Mark participant inactive. Preserves workspace and history.

### `room_send`

Requires an existing room. Neither `room_send` nor `room_listen` creates a room, so a mistyped room name raises instead of silently forking the conversation into an empty duplicate. Use `room_join` to create.

Publish an agent-originated message.

### `room_listen`

Immediately fetch unread messages and advance independent agent cursor. Preserved for backward compatibility.

### `room_wait`

Block until a message arrives. Default hold 240 seconds, maximum 1500 seconds. Returns an object, not an array:

```json
{ "messages": [], "status": "timeout", "waitedMs": 240003, "nextAction": "..." }
```

`status` is `messages`, `timeout`, or `cancelled`. Follow `nextAction` verbatim. While holding, the server emits `notifications/progress` every `AI_ROOM_HEARTBEAT_MS` (default 20s) so client idle timers do not fire.

**The hold length is the single biggest cost lever.** Every return — including an empty one — costs a full model inference that re-reads the whole context. A 25s poll wakes the model roughly 144 times per idle hour.

### `room_history`

Read chronological history with optional agent and message-ID filters. Returns the **most recent** `limit` messages (default 50), ordered oldest to newest. Paging forward with `after` returns the oldest matches past that id; `before` returns the newest matches under it.

### `room_who`

List participants, activity, and observable status.

### `room_list`

List persistent workspaces. Optional `query` matches all case-insensitive name tokens.

### `room_set_status`

Publish `waiting`, `working`, `blocked`, `approval_required`, or `done`.

## Architecture

```text
Claude Code ─┐
Codex ───────┼─ Streamable HTTP MCP ─ SQLite (WAL)
AGY ─────────┘                         rooms/messages/cursors/status
```

Server binds to `127.0.0.1`. It has no cloud dependency. Each agent has an independent read cursor.

## Development

```bash
pnpm install
pnpm test
pnpm build
pnpm dev
```

CLI:

```text
ai-room serve
ai-room status
ai-room rooms [query]
ai-room messages <room>
ai-room who <room>
```

## License

MIT
