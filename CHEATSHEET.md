# ai-room cheatsheet

1. [Server](#1-server)
2. [Opening a room](#2-opening-a-room)
3. [Inside the workspace](#3-inside-the-workspace)
4. [The `human>` console](#4-the-human-console)
5. [Attachments](#5-attachments)
6. [Managing rooms](#6-managing-rooms)
7. [Agent tools](#7-agent-tools)
8. [Storage and cleanup](#8-storage-and-cleanup)

---

## 1. Server

Runs as a macOS LaunchAgent, no Docker: one `node` process on `127.0.0.1:49375`
and SQLite at `~/.ai-room/ai-room.sqlite`. Starts at login and restarts itself
if it crashes.

| Command | Does |
|---|---|
| `ai-room status` | Are the server, database and MCP answering? |
| `~/dev/ai-agent-config/scripts/ai-room-service.sh install` | Installs (or repairs) the service and starts it |
| `~/dev/ai-agent-config/scripts/ai-room-service.sh status` | Is the service installed and running? |
| `~/dev/ai-agent-config/scripts/ai-room-service.sh start` | Starts the server (in the background) |
| `~/dev/ai-agent-config/scripts/ai-room-service.sh stop` | Stops the server (back at next login or `start`) |
| `~/dev/ai-agent-config/scripts/ai-room-service.sh restart` | Restarts the server |
| `~/dev/ai-agent-config/scripts/ai-room-service.sh logs` | Live log (`Ctrl+C` exits, the server keeps running) |
| `~/dev/ai-agent-config/scripts/ai-room-service.sh uninstall` | Removes the service (repo, database and config stay) |

After changing ai-room's code:

```bash
cd ~/dev/ai-room && pnpm build && ~/dev/ai-agent-config/scripts/ai-room-service.sh restart
```

---

## 2. Opening a room

```bash
ai-room open <room> --brief "..." --invite claude,codex,agy
```

| Command | Does |
|---|---|
| `ai-room open <room> --brief "..." --invite ...` | Creates the room, launches the agents and attaches to the workspace |
| `ai-room open <room>` · `ai-room attach <room>` | Reopens the room with the same charter and cast |

| Flag | Does |
|---|---|
| `--tool rtk,graphify` | Tools declared in the briefing |
| `--convention caveman,ponytail` | Writing rules for every agent |
| `--role codex=reviewer` | One agent's role |
| `--no-defaults` | Ignores the defaults in `~/.ai-room/config.json` |
| `--no-files` | No files tab |
| `--mouse` · `--no-mouse` | Mouse in tmux (click to focus a pane, click in the file tree) |
| `--reuse` | Reuses a room that already holds another task's history |
| `--detached` · `--dry-run` | One session per agent · only print the plan |

Defaults for new rooms, in `~/.ai-room/config.json`:

```json
{ "defaults": { "tools": ["rtk", "graphify"], "convention": "caveman,ponytail" } }
```

Flags given on the command line win; an existing room keeps its own charter.
`"invite": ["claude", "codex", "agy"]` and `"mouse": true` are accepted too.

---

## 3. Inside the workspace

Press `Ctrl-b`, let go, then the key. Holding Ctrl for the second key works
too (`Ctrl-b Ctrl-t` = `Ctrl-b t`). On a Mac it is Ctrl, never Cmd.

| Key | Does |
|---|---|
| `F12` | Leaves the workspace; agents keep running |
| `Ctrl-b d` · `Ctrl-b q` | Same detach |
| `Ctrl-b m` | Menu: show/hide agents, the human (monitor) and files |
| `Ctrl-b t` | Goes to the files tab, and back |
| `Ctrl-b 0` · `Ctrl-b 1` | Agents tab · files tab |
| `Ctrl-b M` | Mouse on/off: click a pane to focus it, scroll, drag to copy |
| `Ctrl-b arrows` | Moves between panes |
| `Ctrl-b z` | Pane full screen (again to restore) |
| `Ctrl-b X` | Closes the room (asks first) |

The files tab is a separate tab (window 1), not a pane beside the agents.
Closing the terminal window is only a detach: `ai-room attach <room>` gets you back.
Hiding a pane never stops its agent.

---

## 4. The `human>` console

| Command | Does |
|---|---|
| text + Enter | Sends a message to the room |
| paste several lines | Becomes a single message |
| `/show` · `/clear` | Shows · discards the draft |
| `/who` | Agent status |
| `/attach <agent>` | Goes to the agent's pane |
| `/panes` · `/hide <x>` · `/show <x>` | Lists, hides and shows panes |
| `/agents` | Live panes and sessions |
| `/detach` | Leaves the workspace |
| `/close yes` | Closes the room |
| `/help` · `/quit` | Help · leaves the console |

---

## 5. Attachments

Everything in the draft (text and attachments) goes out as one message on Enter.

| Command | Does |
|---|---|
| `Ctrl+V` or `/paste` | Attaches the screenshot on the clipboard |
| `/file <path>` | Attaches a file (png, jpeg, gif, webp, pdf, text) |
| drag a file in | Attaches it too |
| `/drop <n>` | Removes attachment n from the draft |

Limits: 10MB per file, 5 per message. Agents only receive the metadata and open
the file with `room_attachment` when they need it.

---

## 6. Managing rooms

| Command | Does |
|---|---|
| `ai-room rooms [query]` | Lists rooms (JSON, with activity and participants) |
| `ai-room rooms --names` | Names only, one per line (`\| wc -l` counts them) |
| `ai-room who <room>` | Participants and status |
| `ai-room messages <room>` | History |
| `ai-room pane <room> <pane> [show\|hide\|toggle]` | Shows/hides a pane from the shell |
| `ai-room close <room>` | Closes the panes; history and charter stay |
| `ai-room delete <room> [<room>...]` | Deletes one or more rooms for good (one confirmation); `--yes` for scripts |
| `ai-room rooms test --names \| xargs -o ai-room delete` | Deletes every room matching the query |

---

## 7. Agent tools

| Tool | Automatic? | How to use |
|---|---|---|
| **rtk** | Yes (Claude and Codex) | A hook compresses shell command output. `rtk gain` shows the savings |
| **ponytail** | Yes (Claude and Codex) | Minimal code. `/ponytail lite\|full\|ultra\|off`, `/ponytail-review`, `/ponytail-audit`. On agy only through `--convention ponytail` |
| **caveman** | Through the convention | `--convention caveman`: every agent answers tersely |
| **graphify** | No | The agent runs `graphify extract` and `graphify query "..."` when the room declares `--tool graphify` |
| **grill-me** | No | `/grill-me` in a fresh conversation, plan mode off. Interrogates the plan; writes nothing |
| **grill-with-docs** | No | `/grill-with-docs` in the repo. Same interview, writes `CONTEXT.md` and ADRs in `docs/adr/` |

`--tool` only declares a tool in the briefing; it never installs or runs it.
`--convention` puts the rule in every agent's briefing, agy included.

Install, repair and check:

```bash
~/dev/ai-agent-config/scripts/install-agent-tools.sh
~/dev/ai-agent-config/scripts/doctor.sh
```

---

## 8. Storage and cleanup

| Command | Does |
|---|---|
| `ai-room storage` | Size of the database, attachments and logs; the largest rooms |
| `ai-room storage --json` | Same, as JSON |
| `ai-room attachments prune --older-than 30d` | Deletes old attachment files (history keeps the metadata) |
| `ai-room delete <room> [<room>...]` | Deletes whole rooms |
| `ai-room compact` | Shrinks the database after `delete`/`prune` |

To free space: `storage` → `delete` / `prune` → `compact`.
