# ai-room concepts

How ai-room works and why it works that way. For the commands, see the
[cheatsheet](../CHEATSHEET.md); to get started, the [README](../README.md).

## Design principles

- Solve problems observed in real multi-agent work.
- Preserve MCP backward compatibility.
- Keep rooms local, persistent, and agent-neutral.
- Keep human authorization separate from agent messages.
- Expose state without bypassing harness security.

A room is a persistent collaboration workspace, not a disposable chat. It
stores discussion, participants, independent read cursors, and observable agent
status in SQLite. Work can stop today and continue from the same context
tomorrow.

## One window for everything

```bash
ai-room open refactor-auth --brief "..." --invite claude,codex,agy
```

`open` ends attached to the workspace: it creates or reuses the room, writes
the charter, launches the agents and hands the terminal to tmux **right away**.
The whole workspace is built in a single tmux call, and `open` does not wait for
the agents to join (each harness takes 10–30s to boot; the monitor pane shows
each one arrive). Without an interactive terminal (a pipe, CI), `open` waits for
the joins and reports who made it. Running `ai-room open refactor-auth` again
only reattaches: the charter is kept, the roster's cast is reused and no pane is
duplicated.

```
┌───────────────────────────┬───────────────────────────┐
│ claude                    │ codex                     │
│ interactive session       │ interactive session       │
├───────────────────────────┼───────────────────────────┤
│ agy                       │ monitor | claude:working  │
│ interactive session       │ human> _                  │
└───────────────────────────┴───────────────────────────┘
```

Each agent pane is a real interactive session of that harness, so selecting a
pane lets you talk to that agent directly and answer its own approval prompts.
The monitor pane runs `ai-room console` for the room feed; the agents' status
sits on its top border instead of scrolling through the chat.

A second tab, **files**, is one Vim for the working directory: netrw's tree on
the left, `../` to go up, and the file opened beside it, ready to edit. `:q`
there closes the file and leaves the tree. `AI_ROOM_FILES` picks another
browser (`AI_ROOM_FILES=yazi`), which then gets a Vim pane beside it —
`AI_ROOM_EDITOR` picks another editor; `--no-files` leaves the tab out.

The workspace runs on a tmux server of its own (`tmux -L ai-room`), so its keys
never change your other tmux sessions. Your `~/.tmux.conf` is loaded first; on
top of it, every prefix key also answers with Ctrl held (`Ctrl-b Ctrl-t` is
`Ctrl-b t`):

| Key | Does |
| --- | --- |
| `F12` | Leaves the workspace (detach); agents and room keep running |
| `Ctrl-b d` · `Ctrl-b q` | Same detach |
| `Ctrl-b m` | Pane menu: show or hide each agent, the human (monitor) and files |
| `Ctrl-b t` | Goes to the files tab, and back |
| `Ctrl-b M` | Mouse off/on |
| `Ctrl-b x` · `Ctrl-b X` | Closes the room (asks first); history and charter stay |

Hiding a pane never stops it: the process, the agent's session and its wake
keep going. Outside tmux, `ai-room pane <room> <agent|monitor|files> [show|hide|toggle]`
does the same. Closing the terminal window is only a detach: `ai-room attach <room>`
comes back.

Two channels, deliberately separate:

| Channel | Carrier | Purpose |
| --- | --- | --- |
| human ↔ agent | tmux pane | Direct conversation with one harness |
| agent ↔ agent | ai-room over MCP | Coordination, charter, status |

tmux is a **frontend**, never part of the protocol. `ai-room serve` does not know
whether one is running: close every workspace and the server, rooms and history
are untouched.

| Situation | Behaviour |
| --- | --- |
| tmux installed | Pane workspace (default) |
| `--detached` | One session per agent, each attachable, no attach at the end |
| No tmux | One screen session per agent, with a warning |
| Neither tmux nor screen | Headless processes with a log, with a warning |
| Non-interactive terminal (pipe, CI) | Workspace created, attach command printed |

`ai-room close <room>` kills only that room's workspace. The room, its charter
and its history live in SQLite and survive.

`ai-room storage` shows how much the database, attachments and logs take and
which rooms hold the most (`--json` for scripts). SQLite keeps freed pages for
reuse, so after `delete` or `attachments prune` run `ai-room compact` to shrink
the file.

`ai-room delete <room>` removes the room for good — workspace, history, charter,
participants and attachments (files another room shares are kept). It asks you
to type the room name; `--yes` skips that for scripts. It is a CLI command only,
never an MCP tool, so no agent can delete a room.

### Discovering what ai-room can do

```bash
ai-room tools --json      # the MCP tool catalog
ai-room status --json     # health, version, multiplexer and catalog
curl localhost:49375/tools
```

No MCP handshake required, so bootstrap tooling never has to inspect the
compiled server.

## The console

Agents do not need a terminal each. `ai-room open --detached` starts each one in
its own tmux (or screen) session, and `ai-room console` gives you a single
window with a live feed of the room and a prompt to talk to it — the same
console the workspace's monitor pane runs.

```bash
ai-room open refactor-auth --brief "..." --invite codex,agy --detached
ai-room console refactor-auth
```

```
14:22:07 codex  Found a race in refreshToken().
→ codex needs you (approval_required)  use /attach codex
human> /attach codex
```

Inside the console, anything you type is sent to the room as a message with
`origin: "human"`, which wakes the agents it is for immediately rather than
letting them sit out the rest of their hold: the lead when the room has one,
whoever you name with `@codex …`, everyone with `@all …`. Commands start with `/`, and `Tab`
after `/` completes them:

| Command | Does |
| --- | --- |
| `/attach <agent>` | Focuses that agent's pane (or its session, with `--detached`). Detach with `F12` or `Ctrl-b d` (tmux), `Ctrl-a d` (screen) |
| `/agents` | Lists the room's live panes and sessions |
| `/all` | With a lead, toggles between only the lead and every agent |
| `/approve` | Approves the lead's plan (`room_propose`) and launches the team at its models and efforts |
| `/who` | Participants, `wait(live)` and unread |
| `/show` · `/discard` | Shows · discards the draft |
| `/clear` | Clears the screen; the room's history and the draft stay |
| `Ctrl+V` or `/paste` | Pastes the clipboard: an image or a copied file is attached, text goes into the draft |
| `/file <path>` | Attaches a file (png, jpeg, gif, webp, pdf or text) |
| `/drop <n>` | Removes token n from the draft |
| `/panes` · `/hide <pane>` · `/show <pane>` | Lists, hides and shows workspace panes |
| `/remove <agent>` · `/add <agent> [role]` | Takes an agent out · brings one in |
| `/skills [filter]` · `/<skill> @agent text` | Lists skills · asks an agent to run one |
| `/detach` | Detaches the workspace; agents and room keep running |
| `/reload` | Restarts the console with the ai-room now on disk |
| `/close yes` | Stops the room's panes and sessions; history and charter stay |
| `/quit` | Leaves the console; the agents keep running |

A paste is one thing. The console turns on bracketed paste (`DECSET 2004`), so
the terminal marks where a paste starts and ends; a filter takes that block out
of the stream before readline — which would drop the markers and split it into
one message per line — and puts a token in the line instead: `[Pasted #1: 40
lines]`. The cursor moves around it like any word, Backspace right after it
removes it whole, and Enter sends **one** message with each paste expanded in
its place, worth one history entry, one unread and one wake. Typing and Enter
behave as always. Without a TTY (redirected output, `screen`) a paste cannot be told from
typing, and the old behaviour stays.

### Attachments: a screenshot in `human>`

Take a screenshot, press `Ctrl+V` in the console, write "look at this error"
and press Enter: the agents receive **one** message with the image reachable.

```
human> look at this error [Image #1]▊
```

- A terminal only carries text, so the console reads the clipboard itself
  (`osascript` on macOS, `wl-paste`/`xclip` on Linux) — which is why it works
  inside tmux. Dragging a file into the terminal attaches it too, and `/file`
  covers SSH and any saved file.
- The console uploads the bytes (`POST /attachments`); the server never opens a
  path that came from a client. The type comes from the magic bytes, not the
  extension; SVG is refused. Limits: 10MB per file, 5 per message.
- Files live in `~/.ai-room/attachments/<sha[0:2]>/<sha256>.<ext>` (0600,
  deduplicated by SHA-256). `AI_ROOM_ATTACHMENT_DIR` moves them; inside a git
  repository ai-room writes a `.gitignore` so nothing lands in a commit.
- A message carries metadata only (`attachments: [{id, name, mime, bytes, width,
  height, path}]`), never the bytes: a screenshot costs context only to whoever
  opens it. Older clients keep seeing the same message.
- `room_attachment({room, agent, id})` opens one. Claude gets the path for Read
  (which shows images), Codex the path for `view_image`, and other harnesses —
  or anyone asking `inline: true` — get the image in the result.
- Uploads never sent are removed after 1h. `ai-room attachments prune
  --older-than 30d` frees old files; history keeps their metadata.

The mouse is on: clicking picks a pane, scrolling works, and dragging copies.
Releasing the drag — or `y`/`Enter` in copy mode — sends the selection to the
system clipboard through `pbcopy` (macOS) or `wl-copy`/`xclip` (Linux), without
relying on OSC 52 and without touching your `~/.tmux.conf`: the bindings live in
the running tmux server. With none of those tools, ai-room turns on
`set-clipboard on` and lets the terminal try. `Ctrl-b M`, `--no-mouse` or
`"mouse": false` in the config turn the mouse off, for the terminal's own
selection.

Each agent's status is what it last published. The monitor presents it as
current only when there is evidence behind it: `idle` is an agent that ended its
turn and left a way to be resumed, `idle(waking)` is that agent with a new
message on its way, `wait(live)` is a `room_wait` held on the server right now,
`unread:N` comes from the cursors, `blocked(approval)` is the agent's own
report, and `waiting?7m` is an old status whose evidence expired. Nothing is
inferred from terminal output: no harness exposes "the model is running now",
so the monitor does not pretend to know.

### Why sessions instead of log files

Agents run **interactively** inside the session, not headless. That is deliberate:
a headless run resolves approval prompts on its own, so attaching to it later
would give you nothing to answer. Running in a real TTY keeps every harness gate
intact — you just reach it on demand, from one window, instead of deciding at
launch time which agent deserved its own terminal.

tmux is preferred; screen is used when tmux is absent. Install tmux with
`brew install tmux` on macOS or `sudo apt install tmux` on Ubuntu.

## Room Charters

A charter is the standing briefing for a room: written once, delivered automatically to every agent that joins. It removes the two messages a human otherwise retypes for every collaboration — "create room X, I'm bringing Codex in to help" and "join room X, introduce yourself, you'll be helping Y".

```bash
ai-room open refactor-auth \
  --brief "Refactor the auth middleware. Claude implements, Codex reviews, AGY validates." \
  --convention caveman \
  --tool graphify \
  --invite codex,agy \
  --role codex=reviewer --role agy=validator
```

That creates the room, stores the charter, and launches each invited agent with a seed prompt telling it to join, read its briefing and enter the wait loop. Use `--dry-run` to print the commands without spawning anything, and omit `--invite` to set up a room nobody has joined yet.

`room_join` then returns a briefing tailored to the joining agent:

```json
{
  "brief": "Refactor the auth middleware. ...",
  "you": { "agent": "codex", "role": "reviewer" },
  "teammates": [{ "agent": "agy", "role": "validator" }],
  "conventionPreset": "caveman",
  "conventions": "Respond terse like smart caveman. ...",
  "tools": [{ "name": "graphify", "purpose": "...", "howToUse": "..." }]
}
```

Agents that are not on the roster still receive the shared brief, with `you: null`.

### Convention presets

`caveman`, `ponytail`, `concise`, `rigorous`. A preset is a style contract applied to every agent in the room, so it reaches Claude Code, Codex and AGY uniformly rather than needing a plugin installed per harness. Presets combine: `--convention caveman,ponytail`. Pass `--convention` or `conventionPreset`, or set `conventions` directly for literal text. The caveman rules are derived from the [caveman plugin](https://github.com/JuliusBrussee/caveman) by Julius Brussee (MIT); the ponytail rules from [ponytail](https://github.com/DietrichGebert/ponytail) by Dietrich Gebert (MIT).

### Tool declarations

A charter can declare the tooling a room expects, for example [graphify](https://github.com/Graphify-Labs/graphify) for querying a codebase as a knowledge graph. **ai-room only declares these — it never invokes them.** Each agent runs the tool through its own skills, so ai-room stays a message bus and takes on no dependency of its own. Unknown names are passed through as-is, so you can declare anything.

Defaults for new rooms live in `~/.ai-room/config.json` (`AI_ROOM_CONFIG` to move it):

```json
{ "defaults": { "tools": ["rtk", "graphify"], "convention": "caveman,ponytail" } }
```

They fill only what a **new** room was not given; flags always win, an existing room keeps its charter, and `--no-defaults` skips them. `invite` is accepted too.

Known presets: `graphify`, [`grill-me` and `grill-with-docs`](https://github.com/mattpocock/skills), [`rtk`](https://github.com/rtk-ai/rtk) and [`ponytail`](https://github.com/DietrichGebert/ponytail). `ai-room open` says which declared tools this machine lacks and how to install them; the room opens anyway.

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

### Idle: how an agent stays available for nothing

An agent that has run out of work does not hold a wait. It calls `room_idle`
with the way its harness can be resumed, and ends its turn:

```json
room_idle({room: "x", agent: "codex",
           wake: {kind: "codex-queue", id: "<$CODEX_THREAD_ID>"}})
```

From that moment no model is running for it, so ten minutes of silence cost
exactly nothing. When a message it has not seen lands in the room, ai-room
resumes that session — `codex queue --thread <id>` for Codex,
`claude --resume <id> --bg` for Claude Code — with a short notice that names the
count and nothing else. The agent reads the room itself with `room_listen`,
works, and goes idle again.

This replaces the loop that made a quiet room expensive: a harness cuts a long
tool call short (Codex does it at 31s), the model is activated to collect it,
finds nothing, and issues another wait. One real session spent 53% of its
activations and 56% of its input tokens discovering that nobody had said
anything. No `nextAction`, description or prompt asks for another `room_wait`
any more.

Two guardrails matter. A wake target is `{kind, id}` where `kind` is one of the
harnesses ai-room knows and `id` must look like a session id, so a stored target
can never become a command. And going idle marks where the room stood, so an
agent that chose to sleep on a message is not woken again for it — only
something newer wakes it.

Only a message that is for an agent wakes it. One with `to` is for its
recipients; the human's own words are for the lead; anything else is for the
whole room. The rest read it on their next turn, so nothing is hidden, but a
lead handing work to `claude-2` no longer spends a turn of every other agent.

**Codex asks before running a tool it has not seen.** `room_idle` is new, so
until you allow it once, Codex cannot go idle and will keep its turn alive:

```toml
[mcp_servers.ai-room.tools.room_idle]
approval_mode = "auto"
```

ai-room never changes that file for you.

### Tell a working agent that messages are waiting (PreToolUse hook)

Phase-1 liveness solves the agent that is parked in `room_wait`. The agent that
is *working* has no wait parked, so nothing wakes it: a message stays unread
until it happens to ask again — seven minutes, in one measured session.

`hooks/ai-room-unread-hook.py` closes that at the only safe place, the boundary
before the next tool call. It reads `GET /active` and, when that agent has
unread messages in its room, answers with one line of `additionalContext`:

```
ai-room: 2 unread message(s) in room 'x' for agent 'claude'. Read them with
room_wait(room='x', agent='claude') before continuing work that depends on the
room's context.
```

It is advisory only: it never reads message content, never advances the read
cursor, never sends to the room and never touches a permission decision. The
agent still consumes through `room_wait`/`room_listen` itself. With nothing
unread it prints nothing at all, and every failure — server down, timeout, bad
JSON, unknown identity — is silent and non-blocking.

Identity comes from the launcher and nowhere else: `ai-room open` exports
`AI_ROOM_ROOM` and `AI_ROOM_AGENT` into each agent's process, so the hook asks
about that agent in that room and can never see another room's unread. Without
those variables it says nothing — an agent you started by hand gets no notices
until you export them, and a session that merely mentions a room is never
mistaken for a participant.

What you install is `hooks/ai-room-unread-hook.sh`, a wrapper that answers the
only question that does not need an interpreter — did the launcher put this
session in a room? — and exits otherwise. It runs on every tool call of every
session of that harness, including all the ones that never touch ai-room, and
for those it costs about 9ms instead of the ~56ms of starting Python. Nothing
else lives in the wrapper: endpoint, zero-unread silence, fail-open and logging
all stay in the Python hook it hands over to.

`ai-room hooks` prints where the hook goes for each harness and whether it is
installed. Claude Code takes it in `~/.claude/settings.json`. Codex takes the
same shape in `~/.codex/hooks.json`, but it hashes a hook and asks a human to
trust that exact hash before it will run it — in the TUI it stops at a "Hooks
need review" prompt, so add it only when you can answer that once. ai-room never
approves it for you, and since Codex exposes no documented way to read trust
state, `installed` means the config names the hook, never that Codex will run
it.

Detections are appended to `~/.ai-room/logs/unread-hook.jsonl` — timestamp,
room, agent, unread count and boundary, never message content — and the file is
rotated at 512 KB.

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

Block until a message arrives. Default hold 90 seconds, maximum 1500 seconds. Returns an object, not an array:

```json
{ "messages": [], "status": "timeout", "waitedMs": 90003, "nextAction": "..." }
```

`status` is `messages`, `timeout`, `cancelled`, or `superseded`. The default sits
under the 120s after which Claude Code moves a foreground MCP call to the
background: a hold longer than the host's budget leaves the server holding a
call the model is no longer reading, and messages then wait for the agent to ask
again. A newer `room_wait` for the same `(room, agent)` supersedes the older one,
which returns `superseded` having consumed nothing — one live wait per agent. Follow `nextAction` verbatim. While holding, the server emits `notifications/progress` every `AI_ROOM_HEARTBEAT_MS` (default 20s) so client idle timers do not fire.

**The hold length is the single biggest cost lever.** Every return — including an empty one — costs a full model inference that re-reads the whole context. A 25s poll wakes the model roughly 144 times per idle hour.

### `room_set_charter`

Define a room's brief, conventions, declared tooling and expected roster. Fields left undefined keep their current value.

### `room_charter`

Read a room's charter. Returns null when none is set.

### `room_attachment`

Open one attachment of a room message by the id in `message.attachments`:
metadata and path, the text of a text file, or the image itself for harnesses
that cannot open a path (or with `inline: true`). Read-only.

### `room_history`

Read chronological history with optional agent and message-ID filters. Returns the **most recent** `limit` messages (default 50), ordered oldest to newest. Paging forward with `after` returns the oldest matches past that id; `before` returns the newest matches under it.

### `room_who`

List participants, activity, and observable status.

### `room_list`

List persistent workspaces. Optional `query` matches all case-insensitive name tokens.

### `room_set_status`

Publish `waiting`, `working`, `blocked`, `approval_required`, or `done`.

## Known limitations (0.2.0)

Everything here was observed in a real session with Claude Code, Codex and AGY
in a tmux workspace. None of it blocks the main flow, but knowing it up front
saves you from misreading the symptoms.

### Codex asks for approval once per tool

`approval_mode = "auto"` in `~/.codex/config.toml` does **not** suppress the
first prompt — that was tested. The supported way to stop the prompts is the
interactive dialog's third option, **"Always allow"**, chosen once per tool. In a
real session that meant `room_join`, `room_wait`, `room_history` and `room_send`
separately.

Do **not** reach for `approval_policy = "never"`: it is global and would drop the
shell and filesystem gates too. Per-tool "Always allow" is the granular answer.

### A blocked agent looks like a working one

While Codex waits on its own approval prompt, ai-room sees no event at all, so
`room_who` still reports `working`. There is no reliable signal short of parsing
the harness's terminal output, which is fragile enough that it is deliberately
not done. Watch the pane, or have agents call `room_set_status("approval_required")`
before operations they expect to be gated.

### Typing into a pane queues behind `room_wait`

An agent holding a `room_wait` is never idle, so text typed into its pane
sits in the harness's queue until that call returns. Press `Esc` to interrupt the
wait and release the queued text, or talk through the room (`POST /say`, or the
console prompt), which wakes the agent in milliseconds. This is the direct cost
of the long hold that keeps idle token usage low.

### Stale participants are exposed, not decided

An agent whose process dies without calling `room_leave` stays `active`.
`room_who` reports `lastSeenAt` and `statusUpdatedAt` so you can judge, but
ai-room will not call a participant dead on silence alone: a legitimate
`room_wait` is silent for minutes by design.

### The pane workspace needs tmux

screen cannot be scripted into panes reliably, so it hosts one session per agent
instead. With neither tmux nor screen, agents run headless with logs and `open`
says so. Everything still coordinates; only the human-facing layer degrades.

### Not verified on Ubuntu

The real session ran on macOS. Nothing in the code is macOS-specific — tmux is
found through `PATH` — but Linux has not been exercised.

### Other

- Codex and AGY have no ai-room `Stop` hook. Only Claude Code has one; the other
  harnesses use a different hook I/O shape and would need their own script.
- `--role` only applies to agents named in `--invite`; roles for agents you start
  yourself must be set through `room_set_charter`.
- The monitor pane exits if the server goes down. Agents are unaffected and the
  pane can be restarted with `ai-room console <room>`.
- Restarting the server mid-wait is safe: a broken wait consumes nothing, so
  messages sent during the gap are still delivered afterwards.

## Architecture

```text
Claude Code ─┐
Codex ───────┼─ Streamable HTTP MCP ─ SQLite (WAL)
AGY ─────────┘                         rooms/messages/cursors/status
```

Server binds to `127.0.0.1`. It has no cloud dependency. Each agent has an independent read cursor.

## License

MIT
