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

Runs as a user service (LaunchAgent on macOS, systemd on Linux), no Docker: one
`node` process on `127.0.0.1:49375` and SQLite at `~/.ai-room/ai-room.sqlite`.
Starts at login and restarts itself if it crashes.

| Command | Does |
|---|---|
| `ai-room doctor` | Checks everything ai-room needs and prints the fix for each gap |
| `ai-room status` | Are the server, database and MCP answering? |
| `ai-room service install` | Installs (or repairs) the service and starts it |
| `ai-room service status` | Is the service installed and running? |
| `ai-room service start` | Starts the server (in the background) |
| `ai-room service stop` | Stops the server (back at next login or `start`) |
| `ai-room service restart` | Restarts the server |
| `ai-room service logs` | Live log (`Ctrl+C` exits, the server keeps running) |
| `ai-room service uninstall` | Removes the service (database, rooms and config stay) |
| `ai-room serve` | Runs the server in the foreground, without a service |

After changing ai-room's code:

```bash
pnpm build && ai-room service restart
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
| `ai-room open <room> --invite agy,claude:2` | Reopens it with a **new cast**: whoever is not listed leaves, the room is told, the newcomers are told to read the history |

| Flag | Does |
|---|---|
| `--tool rtk,graphify` | Tools declared in the briefing |
| `--convention caveman,ponytail` | Writing rules for every agent |
| `--role codex=reviewer` | One agent's role |
| `--lead agy` · `--no-lead` | Picks the agent who talks to you · none (see below) |
| `--model codex=gpt-5.5` | One instance's model, in its CLI's own names (`agy models` lists agy's) |
| `--effort codex=medium,agy=low` | One instance's reasoning effort: `low`, `medium`, `high`, `max` |
| `--no-plan` | Launches the whole team at once, without waiting for the lead's plan |
| `--no-defaults` | Ignores the defaults in `~/.ai-room/config.json` |
| `--no-files` | No files tab |
| `--no-mouse` | Starts with the mouse off (it is on by default) |
| `--reuse` | Reuses a room that already holds another task's history |
| `--detached` · `--dry-run` | One session per agent · only print the plan |

### One agent talks to you: the lead

With two or more agents, a new room gets a **lead**: the only agent that
addresses you. The others pass what they need from you through it.

- The `human>` console shows only the lead, and only when it talks to you or
  the whole room: agents address teammates with `room_send`'s `to`, and those
  asides stay out of your pane. The lead keeps you up to date on the team's
  thinking and credits who found what ("agy found…", "codex hit…"). Everything
  stays in the room; `/all` shows it here too, as `claude → claude-2`.
- Picked by preference: claude, then agy, then codex (codex runs out of usage
  first). `--lead <agent>` chooses; `--no-lead` or `"lead": false` in the
  config turns it off; `"lead": ["agy", "claude", "codex"]` changes the order.
- Your plain messages wake the lead alone. `@codex …` (or `@codex @agy …`)
  goes to whoever you name, `@all …` to everyone.
- Every ask is its own message, numbered: `[FOR YOU #3] ...` — answer `#3 a`.
- Anything to read or forward arrives as a file in `.ai-room/for-human/`
  (git-ignored), opened in the files tab: `[FOR YOU] deliverable: <path>`.
- If the lead leaves (`ai-room remove`), the next agent by preference takes over
  and the room is told.

### The lead sizes the task first

A new room with a brief and two or more agents opens with **the lead alone**.
The lead takes a quick look, sizes the task by its touch points ("4 small
changes in 2 files"), and proposes the team with `room_propose`: each agent's
role, model and effort. The plan arrives in your console; `/approve` launches
the team at those levels. `/approve` with no plan launches whoever is waiting
at their default level, and `--no-plan` skips the step.

A plan has at least two agents, and never everyone on a light setting (a low
effort or a haiku/mini/lite/-low model). One agent is still possible: invite
only one.

Who is woken: a message with `to` wakes only its recipients, one without `to`
wakes the whole room. Everyone reads everything once awake; this only stops a
delegation to `claude-2` from waking `codex` to read it and reply "ok". The
lead sends findings and decisions without `to`, so the others still weigh in
where it matters.

### Several instances of one agent

Number them: the name picks the CLI, so `claude-2` runs Claude Code as a separate
participant, with its own pane, session and wake.

```bash
ai-room open review --brief "..." --invite claude:3,codex:2 \
  --role claude=implementer --role claude-2=skeptic --role claude-3=security
```

`claude:3` or `"claude*3"` is three instances in total: `claude`, `claude-2`,
`claude-3` (at most 5 of one agent). In zsh an unquoted `*` is a file glob and
fails with `no matches found`: quote it, use `:`, or add
`alias ai-room='noglob ai-room'` to `~/.zshrc`.

`ai-room open` trusts the folder it runs in for Claude Code and Codex (in
`~/.claude.json` and `~/.codex/config.toml`), so no pane stops at "trust this
folder?". Claude's question defaults to "No, exit", which with several claude
panes used to close one of them.

Same model, independent samples: they reach different conclusions, but in one
room they drift toward whoever spoke first. Give each a different `--role` to
keep the views apart. Each instance spends its own tokens; with many panes use
`Ctrl-b z` to zoom one and `Ctrl-b m` to hide the rest.

Defaults for new rooms, in `~/.ai-room/config.json`. `ai-room setup` asks for
them, suggesting the agents and tools it finds installed; the first
`ai-room open` offers it when the file does not exist yet. By hand:

```json
{ "defaults": { "tools": ["rtk", "graphify"], "convention": "caveman,ponytail" } }
```

Flags given on the command line win; an existing room keeps its own charter.
`"invite": ["claude", "codex", "agy"]` and `"mouse": false` are accepted too.

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
| `Ctrl-b M` | Mouse off/on. On (default): click a pane to focus it, scroll, drag to copy |
| `Ctrl-b arrows` | Moves between panes |
| `Ctrl-b z` | Pane full screen (again to restore) |
| `Ctrl-b x` or `Ctrl-b X` | Closes the room (asks first) |

The files tab is a separate tab (window 1): one Vim, the tree on the left and
the file on the right. In the tree, Enter opens the file beside it, `-` or
`../` goes up, `p` previews; `:w` saves, `Ctrl-w w` moves between the two, and
`:q` on the file leaves the tree. In the tree: `%` new file, `d` new folder,
`R` renames, `D` deletes. `AI_ROOM_FILES=yazi` brings back yazi, with a Vim pane
beside it; `AI_ROOM_EDITOR` picks another editor.
Copying text out of a pane: drag inside it, and releasing copies to the
clipboard. Without the mouse: `Ctrl-b [`, move to the start, `Space`, move to
the end, `Enter`. For the terminal's own selection across panes, turn the mouse
off with `Ctrl-b M`.

Pasting in `human>`: `Ctrl+V` pastes anything (text, a screenshot, a copied
file); `Cmd+V` only text, because the terminal itself cannot paste an image.

Closing the terminal window is only a detach: `ai-room attach <room>` gets you back.
Hiding a pane never stops its agent. To stop one for good, use `ai-room remove`:
it leaves the roster (reopening will not relaunch it), is no longer woken, and
the room is told so the others pick up its part.

---

## 4. The `human>` console

| Command | Does |
|---|---|
| text + Enter | Sends a message to the room |
| paste several lines | Becomes a single message |
| `/show` · `/clear` | Shows · discards the draft |
| `/all` | With a lead: toggles between only the lead and every agent |
| `/who` | Agent status (it is also always on the monitor's top border) |
| `/attach <agent>` | Goes to the agent's pane |
| `/panes` · `/hide <x>` · `/show <x>` | Lists, hides and shows panes |
| `/agents` | Live panes and sessions |
| `/remove <agent>` · `/add <agent> [role]` | Takes an agent out · brings one in |
| `/approve` | Approves the lead's plan and launches the team (no plan: launches whoever is waiting) |
| `@codex …` · `@all …` | A message for one agent · for everyone (plain text goes to the lead) |
| `/add codex sim` | Codex already there: confirms another instance, numbered for you |
| `/detach` | Leaves the workspace |
| `/close yes` | Closes the room |
| `/skills [filter]` | Project, user and plugin skills, with their descriptions |
| `/` + `Tab` | Completes console commands and skill names |
| `/<skill> @agent text` | Asks that agent to run the skill: types `/skill text` (Claude, agy) or `$skill text` (Codex) in its pane |
| `/<skill> text` | Without `@`: asks the room, and whoever fits runs it |
| `/reload` | Restarts this console with the ai-room now on disk (it says when there is a newer one) |
| `/help` · `/quit` | Help · leaves the console |

---

## 5. Attachments

A paste or an attachment lands in the line as a token — `[Pasted #1: 40 lines]`,
`[Image #2]`, `[PDF #3: spec.pdf]` — like in Claude Code and Codex. Move the
cursor around it and keep writing; Backspace right after a token removes it
whole. Enter sends the line as one message, each paste expanded in its place.
`/show` lists the tokens, `/clear` drops them all.

| Command | Does |
|---|---|
| `Ctrl+V` or `/paste` | Pastes the clipboard: a screenshot or a copied file is attached, text goes in as a token |
| `/file <path>` | Attaches a file (png, jpeg, gif, webp, pdf, text) |
| drag a file in | Attaches it too |
| `/drop <n>` | Removes token n from the draft |

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
| `ai-room remove <room> <agent>` | Takes one agent out (e.g. it hit its usage limit); the rest keep working |
| `ai-room add <room> <agent> [--role <role>]` | Brings an agent in, or back, with its own pane |
| `ai-room add <room> codex --yes` | Codex already there: opens the next instance (`codex-2`, `codex-3`…) without asking |
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

`ai-room doctor` lists which of these are installed and the install command
for each one that is not. Installing plugins and hooks is left to you: it
changes each agent's own configuration.

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
