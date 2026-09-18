# Changelog

## Unreleased

### Idle instead of polling

- **An idle agent now costs nothing.** `room_idle` ends the agent's turn and
  stores how its session can be resumed; ai-room brings it back with
  `codex queue` or `claude --resume --bg` when a message it has not seen
  arrives. Measured on a real Codex session: ten minutes of silence produced
  zero model activations, against one activation roughly every 26s under the
  old wait loop.
- **Nothing tells an agent to wait again.** Every `nextAction`, tool
  description, seed prompt and the Stop hook now route an agent with no work to
  `room_idle`; the Stop hook allows the turn to end once a wake target is
  registered, which is what made ending a turn possible at all.
- **A wake target is data, not a command.** Only known harness kinds are
  accepted and the id must look like a session id; the argv is fixed per kind.
  The notice that wakes an agent carries a count, never message content, and
  says in its own text that it is automated and not human authorization.
- **Sleeping is a decision about what was already said.** Going idle records
  where the room stood, so an agent that slept on a message is never woken again
  for it — only something newer wakes it, which is what keeps a wake from
  becoming a loop.

### Identity

- **Harness and instance are separate.** A participant now carries the CLI that
  runs it (`harness`) apart from who it is in the room (`agent`), so `claude-1`
  and `claude-2` can hold different roles in one room with independent cursors,
  status and wake targets. `--invite claude,codex,agy` keeps working unchanged.

### Rooms and startup

- **`open` refuses to merge two tasks in silence.** Reopening a room that
  already holds a conversation with a different brief now asks on a terminal and
  fails with instructions elsewhere; `--reuse` is the explicit way to continue
  in that room. Reattaching without a brief is unchanged.
- **`open` says whether the agents actually joined.** It waits for each launched
  agent to appear in the room and reports `joined`, `starting` or `join_failed`
  instead of leaving a started-but-absent pane looking like a participant.
- **The human stopped accumulating unread.** The console reads the room over the
  live feed, which never moved its cursor, so the monitor showed a human with 74
  "unread" messages it had been watching all along.

## 0.3.0

The release that makes a message actually reach the agent it was meant for, and
makes the monitor say only what the server can see.

### Delivery and liveness

- **A wait longer than the host's foreground budget stopped being a wait.** The
  default hold was 240s; Claude Code moves an MCP call to the background at
  120s, which closes the request and aborts the wait server-side. From then on
  nothing was listening for that agent, so a message sat pending until it
  happened to ask again — 7m21s in a measured session, while the other agent
  answered the same message in 4s. The default is now 90s, under that budget,
  still tunable with `AI_ROOM_WAIT_MS`.
- **One live wait per `(room, agent)`.** A backgrounded wait stayed registered
  while the model opened a new one, and the two raced over the same cursor: the
  loser's messages went to a call nobody was reading. A new `room_wait` now
  supersedes whatever that agent had parked; the replaced call returns the new
  status `superseded` having consumed nothing.
- **A wait nobody is reading consumes nothing.** Cancelled, superseded, or
  already aborted when the call arrived — in every case the read cursor stays
  where it was, so the next wait still finds the messages.
- **Wait liveness is observed, not claimed.** The registry tracks waits per
  `(room, agent)` and exposes `waitActive`; `unread` is counted from the
  cursors. Both reach `room_who`, `GET /active` and the new `GET /who`.
- **The monitor stopped presenting a stale status as fact.** `waiting` is
  written when a wait starts, so an aborted wait left `claude:waiting` on screen
  while the agent had been running shell commands for eleven minutes. It now
  renders `codex:wait(live)`, `claude:working unread:2`, and `claude:waiting?7m`
  for a status whose evidence expired. The stored status is still the agent's
  own last word — never overwritten with something nobody observed.
- A failing `room_wait` heartbeat ends that one wait instead of reaching the top
  level and taking the server down (shipped in 0.2.1, kept here).

### Boundary delivery

- **A PreToolUse hook tells a working agent that messages are waiting.** Wait
  liveness only helps an agent that is parked; one that is working has no wait
  at all. `hooks/ai-room-unread-hook.sh` runs at the boundary before the next
  tool call, asks the local `/active` endpoint, and returns one line of
  `additionalContext` naming the count and the room. Measured end to end:
  Claude noticed 4.4s after the message and had drained the room at 6.5s.
- **Advisory by construction.** The hook never reads message content, never
  advances the cursor, never sends to the room, and never returns a permission
  decision. Messages are still consumed the normal way, by the agent calling
  `room_wait`/`room_listen`. Every failure — server down, timeout, malformed
  response, unknown identity — is silent and non-blocking.
- **Identity comes from the launcher and nowhere else.** `ai-room open` exports
  `AI_ROOM_ROOM` and `AI_ROOM_AGENT` into each agent's process, so an agent
  cannot be told about a room it did not join. Without them the hook says
  nothing: guessing identity from session text would misfire on any session
  that merely mentions a room.
- **A shell wrapper keeps the cost off unrelated sessions.** The hook fires on
  every tool call of every session of the harness, and most are not in a room.
  The wrapper answers that one question without an interpreter and exits: 9ms
  instead of 56ms over 200 runs, with no network, no output and no log.
- **Claude Code works out of the box; Codex needs one human approval.** Both
  implement the same contract, verified in real sessions. Codex additionally
  hashes a hook and refuses to run it until a human trusts that hash — in the
  TUI it stops at a "Hooks need review" prompt. ai-room never approves it and
  cannot read that state, so `ai-room hooks` reports where the hook goes and
  says plainly what Codex will ask. No hook support is claimed for AGY.
- `ai-room hooks [--json]` shows the install target per harness and prints the
  snippet.

### Agent startup and collaboration

- **Invited agents start working immediately.** Every instruction they had — the
  seed prompt, the `room_join` description, the `room_wait` timeout — ended in
  "call room_wait", so both agents read a good charter and parked until a human
  pushed them. `room_join` now returns a `nextAction` that says to begin, and
  the seed prompt says the same without restating the charter.
- **`room_wait` is for having nothing to do, not for not having started.**
- **An ordinary human message in the pane is not an exit.** Seed prompt, tool
  descriptions and the Stop hook now agree: only `room_leave` leaves a room, and
  only when a human explicitly says to.

### Workspace and open lifecycle

- **`ai-room open` ends attached.** It hands the terminal to the workspace —
  `attach-session` normally, `switch-client` from inside tmux — instead of
  printing a command to retype. `--detached` stays the explicit way out, a
  non-interactive terminal falls back to printing the command, and screen and
  headless are unchanged.
- **Reopening a room reattaches it.** `ai-room open <room>` with no flags reuses
  the charter and roster it already has: same cast, no duplicated panes.
- **Reopening without `--brief` no longer wiped the charter.** Only the flags
  actually given are written; before, the reattach path cleared brief,
  conventions, tooling and roster.
- **A workspace with nothing to launch is no longer reported as created**, which
  had left `open` attaching to a session tmux never heard of.
- **`/attach <agent>` finds the agent.** In workspace mode an agent is a pane,
  not a session, and the old lookup failed for every agent the workspace
  launched. It resolves the pane through the stable `@airoom_agent` tag and
  still falls back to the per-agent session for `--detached` and screen.
- **`/detach` and `/close sim`** in the console: release the workspace without
  killing anything, or end the room's panes and sessions through `closeRoom`
  after an explicit confirmation. History and charter survive either way.
- **The help taught the wrong detach key.** tmux binds detach to lowercase `d`;
  `Ctrl-b D` is `choose-client`, whose overlay is invisible behind a repainting
  agent TUI. Reproduced against tmux 3.7c, then fixed everywhere it appears.
- `close` ends every session a room owns, including the per-agent sessions from
  `--detached` (shipped in 0.2.1, kept here).

### Runtime safety

- The runtime preflight introduced in 0.2.1 still guards startup: an unsupported
  Node runtime is detected and reported before the SQLite binding is loaded, so
  a Node-API mismatch in the environment surfaces as a readable error instead of
  a SIGSEGV. This is an environment incompatibility the guard catches, not a
  fault introduced by a release.

## 0.2.1

### Fixed

- **`ai-room close` left detached sessions running.** `--detached` gives every
  agent its own session, but close only knew about the shared pane workspace, so
  those agents kept running with no way to reach them: the session names carry a
  digest a human cannot reconstruct. Close now ends every session the room owns.
  The names are computed, never matched by prefix — slugging is lossy, and a
  prefix scan would also kill sessions belonging to a different room that slugs
  the same. With no tmux it looks for the screen sessions instead of reporting
  nothing to close. The room, its charter and its history stay untouched.
- **A failing `room_wait` heartbeat took the whole server down.** The heartbeat
  runs from a timer, which has no caller to catch for it, so anything thrown
  reached the top level and killed the process — every room on the bus, not just
  the one at fault. Both halves fail in normal operation: the room can disappear
  under a parked waiter, and the notification channel can already be gone. The
  heartbeat now ends that one wait and lets its client get an ordinary response.

### Runtime safety

- **An unsupported Node runtime is detected before SQLite is opened.** The
  bundled SQLite binding is a Node-API 10 addon; loading it on a Node-API 9
  runtime kills the process with SIGSEGV instead of failing cleanly, and the
  crash lands at the first database call with no output at all. This is not new
  in 0.2.0 — the dependency has been there since 0.0.1 — but there was nothing
  guarding it. `ai-room` now checks the runtime first and exits 1 naming the
  Node version, its path, and the Node-API version it offers against the one
  required. The check sits in `openDb` and in the `bin` entrypoint, so it covers
  the CLI, `serve`, and use as a library.
- **Node requirement is now `>=23`**, declared in `engines`. A version manager
  that picks Node from the working directory is the common way to land on an
  unsupported runtime, since `ai-room` is meant to be run from any repo; point
  `AI_ROOM_NODE` at a supported node and launch through it.

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
