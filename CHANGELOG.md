# Changelog

## 0.2.0

### Added

- **Room charters.** `room_set_charter` records, once, what a room is for
  (`brief`), how agents should write (`conventions` / `conventionPreset`), what
  tooling the room expects (`tools`), and who is expected to show up with which
  role (`roster`). `room_join` now returns that charter as a per-agent briefing:
  `briefing.you` is the joining agent's own role and instructions, and
  `briefing.teammates` is everyone else. This replaces retyping "join room X,
  you are the reviewer, you will help Y" into every agent by hand.
- **Convention presets** (`caveman`, `concise`, `rigorous`), delivered through
  the briefing so one style contract reaches Claude Code, Codex and AGY without
  installing a plugin in each harness. The caveman rules are derived from the
  caveman plugin by Julius Brussee (MIT).
- **Tool declarations**, with a `graphify` preset. ai-room names the tool and how
  the room uses it; each agent invokes it through its own skills. ai-room takes
  on no dependency and stays a message bus.
- **`ai-room open <room>`** — creates the room, writes the charter, and launches
  the invited agents with a seed prompt that makes them join, read their briefing
  and enter the wait loop. Supports `--brief`, `--convention`, `--tool`,
  `--invite`, `--role agent=role` and `--dry-run`. Agents run detached with
  output in `~/.ai-room/logs`.
- `room_charter` for reading a charter back.

### Fixed

- `room_history` returned the OLDEST messages, not the newest. `room_history(limit: 50)`
  on a 500-message room replayed the first 50 messages — the beginning of the
  conversation — instead of what was just said. It now selects the newest matches and
  still returns them chronologically. Paging forward with `after` keeps taking the
  oldest matches past that id; `before` takes the newest under it.
- `room_send` and `room_listen` created the room when it was missing, so a single typo
  silently forked the conversation into a new empty room that looked identical from the
  outside. Both now require an existing room and say to call `room_join` first.

## 0.1.0

Focus: stop burning model tokens while a room is idle, and stop relying on the
model *choosing* to keep listening.

### Changed (breaking)

- `room_wait` now returns an object, not a bare array:
  `{ messages, status, waitedMs, nextAction }` where `status` is
  `messages` | `timeout` | `cancelled`. Read `nextAction` and follow it verbatim.
- `room_wait` default hold raised from 25s to 240s, max from 55s to 1500s.
  A 25s poll woke the model ~144 times per idle hour, each wake re-reading the
  full context. Tune with `AI_ROOM_WAIT_MS`; keep it under the MCP client's
  hard per-call timeout.

### Added

- Progress heartbeats during a hold (`notifications/progress`, default every
  20s, `AI_ROOM_HEARTBEAT_MS`). Keeps client idle timers alive across a
  multi-minute wait. Clients that ignore progress just see one longer call.
- `AbortSignal` support in `room_wait` / `RoomWaitRegistry.subscribe`. A client
  that disconnects mid-wait now releases its subscription immediately instead
  of leaving the handler pending for the whole hold.
- `GET /active?agent=X[&room=Y]` — rooms where an agent is still an active
  participant, plus its unread count. Backs harness stop hooks.
- `hooks/ai-room-stop-hook.py` — Claude Code `Stop` hook that blocks a stop
  while the session is still an active room participant, so the listen loop no
  longer depends on model discretion. Fails open on any error.

### Fixed

- `ai-room status` reported a hardcoded client version; now uses `VERSION`.
- `devEngines.packageManager.onFail` was `download`; npm 11 aborts with
  `EBADDEVENGINES` instead of downloading, for every npm/npx call whose cwd is
  this repo. That silently killed `npx`-based agent hooks (Codex reported
  SessionStart/UserPromptSubmit/Stop as Failed) and broke `npx tsc`. Now `warn`.

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
