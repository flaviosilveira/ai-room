# Changelog

## 0.2.0

Feature freeze. Known limitations are documented in the README under
"Known limitations (0.2.0)" — notably Codex's per-tool approval prompts, why a
blocked agent still reads as `working`, and that the pane workspace needs tmux.

### Added

- **tmux pane workspace.** `ai-room open` creates one tmux session per room
  (`airoom-<room>`) with a pane per agent plus a monitor pane running
  `ai-room console`. Reopening a room attaches to what is already there and adds
  only the missing panes. `ai-room close <room>` kills that one session and
  nothing else — never `kill-server`, and never the room itself: the workspace
  and the room in SQLite are separate entities.
- **`--detached`** keeps the previous behaviour (one session per agent), and
  `--no-monitor` drops the monitor pane. With no tmux, `open` degrades to
  per-agent sessions; with neither tmux nor screen it degrades to headless
  processes with logs, and says so. It never fails outright.
- **Capability discovery without an MCP handshake**: `GET /tools`,
  `ai-room tools [--json]`, and `ai-room status --json`. External tooling was
  reading `registerTool` out of `dist/server.js`; that is now a supported
  interface. A test asserts the catalog matches what the server registers, so the
  two cannot drift.

### Fixed

- **A cancelled `room_wait` consumed messages and lost them.** On abort the
  handler still drained the room and advanced the read cursor, so messages were
  handed to a client that had already gone away and reached nobody. Interrupting
  an agent's terminal aborts its in-flight wait, so this was reachable from
  ordinary use. A cancelled wait now consumes nothing.
- **A direct terminal conversation made agents leave the room.** The `room_wait`
  description said the loop ends "via room_leave or a direct human instruction",
  which reads as authorisation to stop participating the moment a human types in
  the pane. Answering a human is now explicitly not an exit; only `room_leave` is.
- **tmux session names collided.** "refactor:auth", "refactor auth" and
  "refactor-auth" all slugged to one name, dropping three different rooms into a
  single workspace, and a per-agent session could take a workspace's name. Names
  now carry a digest of the exact identity, and stay deterministic so reattach
  still finds the same session.
- **Pane tags landed on the wrong pane.** Tagging targeted the session's active
  pane, which `select-layout` can change, so an agent's tag could end up on
  another agent's pane — one pane was labelled `monitor` while running an agent.
  The tag now targets the pane id tmux reports when it creates it.
- **The monitor pane ran a command that does not exist** in a repo checkout,
  where `ai-room` is not on PATH. It falls back to the current node binary.
- `room_who` showed `role=None`. `room_join` now mirrors the charter roster's
  role onto the participant, so roles are visible without a second lookup. The
  roster stays the single source of truth and an explicit role still wins.
- **`pnpm build` failed in any non-interactive context** with
  `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`. The cause was not the script:
  `node_modules` had been installed by pnpm 10 (store v10) while the active pnpm
  was 11 (store v11), so pnpm insisted on purging and reinstalling, and the purge
  prompt needs a TTY. `verify-deps-before-run` and `devEngines` were both tested
  and ruled out. Resyncing the install fixes it; `confirm-modules-purge=false`
  now lets a future major transition resync unattended instead of dead-ending in
  CI, scripts or a service manager. Consumers no longer need to call
  `node_modules/.bin/tsc` to work around it.
- Pane identity no longer depends on `pane_title`. Agents rewrite their own title
  through escape sequences — Codex sets it to "[ ! ] Action Required" — which made
  reopening a room duplicate every pane. Identity now lives in a tmux user option
  the application cannot reach.

- **`ai-room console <sala>`** — one window for the whole room: a live feed of
  messages and participant status, plus a prompt to talk to the room. Agents that
  report `approval_required` or `blocked` are called out with the command to
  reach them.
- **Agents run in detached tmux or screen sessions**, interactively, instead of
  headless with output in a log file. That costs a multiplexer but buys a real
  TTY, so each harness's own approval prompt still exists and a human can
  `/attach <agent>` to answer it — no dangerous bypass flags, and no need to
  guess at launch time which agent will need attention. tmux is preferred and
  screen is the fallback; both are supported on macOS and Ubuntu.
- **`POST /say`** writes a message with `origin: "human"` and wakes every waiter
  in the room immediately. `origin` has been in the schema since 0.0.2 with
  nothing ever writing "human"; this is the channel it was declared for. It is
  set server-side, so an agent calling `room_send` can never claim to be the
  human.
- **`GET /stream?room=X`** — SSE feed of messages and status changes, with
  replayed backlog, used by the console.
- `ai-room agents <sala>` lists the live agent sessions and how to attach.

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
