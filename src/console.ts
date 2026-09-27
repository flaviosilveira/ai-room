import fs from "node:fs";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import { spawnSync } from "node:child_process";
import {
  INSTALL_HINT,
  agentPane,
  attachWorkspace,
  listTaggedPanes,
  canAttach,
  detachWorkspace,
  detectMultiplexer,
  focusPane,
  insideWorkspaceServer,
  liveSessions,
  mux,
  paneStates,
  reloadTmuxConfig,
  STATUS_TAG,
  sessionExists,
  sessionName,
  setPaneVisible,
  typeIntoPane,
  workspaceName,
} from "./session.js";
import { closeRoom, harnessFor } from "./invite.js";
import { STATUS_STALE_MS } from "./wait.js";
import {
  DISABLE_BRACKETED_PASTE,
  ENABLE_BRACKETED_PASTE,
  createPasteStream,
  normalizePaste,
} from "./paste.js";
import { formatBytes } from "./attachments.js";
import { pastedFilePath, readAttachableFile, readClipboard } from "./clipboard.js";
import { discoverSkills, renderSkills, skillLine, skillVisibleTo } from "./skills.js";
import type { Skill } from "./skills.js";
import type { MultiplexerDriver } from "./session.js";
import type { AttachmentInfo, MessageInfo, ParticipantView } from "./types.js";

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  human: "\x1b[36m",
  agent: "\x1b[32m",
  system: "\x1b[35m",
  warn: "\x1b[33m",
  alert: "\x1b[31m",
};

const STATUS_COLOR: Record<string, string> = {
  working: C.agent,
  idle: C.dim,
  waiting: C.dim,
  blocked: C.warn,
  approval_required: C.alert,
  done: C.dim,
};

function stamp(ms: number): string {
  return new Date(ms).toTimeString().slice(0, 8);
}

/**
 * Prints above the prompt line without mangling what the user is mid-way
 * through typing: clear the line, write, then let readline repaint.
 */
function emit(rl: readline.Interface, line: string): void {
  // The draft may wrap over several rows. getCursorPos() knows how many; the
  // rows readline itself remembers (prevRows) go stale while the human types at
  // the end of the line, and its redraw then climbs over the line just printed.
  // So the draft is erased here, and readline is told it now starts from row 0.
  const { rows } = rl.getCursorPos();
  if (rows) readline.moveCursor(process.stdout, 0, -rows);
  readline.cursorTo(process.stdout, 0);
  readline.clearScreenDown(process.stdout);
  process.stdout.write(`${line}\n`);
  // ponytail: internal readline field; if Node renames it, the redraw can leave a stale row again
  (rl as unknown as { prevRows: number }).prevRows = 0;
  rl.prompt(true);
}

export function attachmentChip(a: Pick<AttachmentInfo, "name" | "mime" | "bytes">): string {
  const kind = a.mime.startsWith("image/") ? "img" : a.mime === "application/pdf" ? "pdf" : "file";
  return `[${kind} ${a.name} ${formatBytes(a.bytes)}]`;
}

function renderMessage(m: MessageInfo): string {
  const color = m.origin === "human" ? C.human : m.origin === "system" ? C.system : C.agent;
  const who = (m.origin === "human" ? `${m.agent} (you)` : m.agent) + (m.to?.length ? ` → ${m.to.join(", ")}` : "");
  const chips = m.attachments?.length ? ` ${C.warn}${m.attachments.map(attachmentChip).join(" ")}${C.reset}` : "";
  return `${C.dim}${stamp(m.createdAt)}${C.reset} ${color}${C.bold}${who}${C.reset}  ${m.content}${chips}`;
}

function age(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
}

/**
 * What one participant looks like when the monitor only claims what the server
 * can see. `status` is the agent's own last word about itself, so it is shown
 * as current only while there is evidence behind it: a live room_wait, or a
 * recent update. A stale "waiting" — the status of an agent whose wait the host
 * moved to the background minutes ago — is marked, not repeated as fact.
 */
export function renderParticipant(
  p: ParticipantView,
  now = Date.now(),
  staleMs = STATUS_STALE_MS
): string {
  const since = now - p.statusUpdatedAt;
  const unread = p.unread > 0 ? ` unread:${p.unread}` : "";
  const paint = (label: string, color: string) =>
    `${color}${p.agent}:${label}${C.reset}${unread ? `${C.warn}${unread}${C.reset}` : ""}`;

  // Observed by the server, in order of how much evidence there is.
  if (!p.active) return paint(p.status === "done" ? "finished" : "offline", C.dim);
  if (p.wakeError) return paint(`wake_failed`, C.alert);
  if (p.status === "idle" && p.wake) {
    // Idle is a fact the agent declared AND backed with a way to be resumed:
    // no model is running, and the room can reach it.
    return paint(unread ? "idle(waking)" : "idle", C.dim);
  }
  if (p.waitActive) return paint("wait(live)", C.dim);
  if (p.status === "approval_required") return paint("blocked(approval)", C.alert);
  if (p.status === "blocked") {
    return paint(p.statusDetail ? `blocked (${p.statusDetail})` : "blocked", C.warn);
  }
  if (p.status === "waiting") return paint(`waiting?${age(since)}`, C.warn);
  const stale = since > staleMs;
  const detail = p.statusDetail ? ` (${p.statusDetail})` : "";
  return paint(`${p.status}${stale ? `·${age(since)}` : ""}${detail}`, STATUS_COLOR[p.status] ?? C.dim);
}

/** The agents only: the human's own status is noise on its own screen. */
export function statusParts(participants: ParticipantView[]): string[] {
  return participants
    .filter((p) => p.agent !== "human" && (p.active || p.status === "approval_required"))
    .map((p) => renderParticipant(p));
}

const ANSI_TO_TMUX: Record<string, string> = {
  [C.reset]: "#[default]",
  [C.dim]: "#[dim]",
  [C.bold]: "#[bold]",
  [C.human]: "#[fg=cyan]",
  [C.agent]: "#[fg=green]",
  [C.system]: "#[fg=magenta]",
  [C.warn]: "#[fg=yellow]",
  [C.alert]: "#[fg=red]",
};

/** Terminal colours as tmux styles, and "#" escaped so tmux does not read it as a format. */
export function toTmuxStyle(text: string): string {
  return text.replace(/#/g, "##").replace(/\x1b\[[0-9;]*m/g, (code) => ANSI_TO_TMUX[code] ?? "");
}

function renderStatus(participants: ParticipantView[]): string {
  const parts = participants
    .filter((p) => p.active || p.status === "approval_required")
    .map((p) => renderParticipant(p));
  return `${C.dim}${stamp(Date.now())} —${C.reset} ${parts.join("  ") || `${C.dim}room is empty${C.reset}`}`;
}

/** Agents whose status means a human has to go look at them. */
function needsAttention(participants: ParticipantView[]): ParticipantView[] {
  return participants.filter(
    (p) => p.status === "approval_required" || p.status === "blocked"
  );
}

/** The workspace's own tmux server binds all of these; screen keeps its default. */
export const DETACH_KEYS = "F12 · Ctrl-b d (tmux) · Ctrl-a d (screen)";

export const HELP = `
${C.bold}Commands${C.reset}
  ${C.bold}/attach <agent>${C.reset}    focus the agent's pane (back with ${DETACH_KEYS})
  ${C.bold}/agents${C.reset}            list the room's live panes and sessions
  ${C.bold}/all${C.reset}               with a lead, toggle between only the lead and every agent
  ${C.bold}/who${C.reset}               participants: idle/working/wait(live) and unread
  ${C.bold}/panes${C.reset}             workspace panes and which are visible (files is tab 1: Ctrl-b t)
  ${C.bold}/hide <pane>${C.reset}       hide a pane (agent, monitor or files) without stopping it
  ${C.bold}/show <pane>${C.reset}       show a hidden pane again
  ${C.bold}/remove <agent>${C.reset}    take an agent out (e.g. it hit its limit); the rest keep working
  ${C.bold}/add <agent> [role]${C.reset} bring an agent in, new or back
  ${C.bold}/approve${C.reset}           approve the lead's plan and launch the team (with no plan: launch who is waiting)
  ${C.bold}/allow [n]${C.reset}         list what agents were stopped from doing; allow request n once
  ${C.bold}/deny <n>${C.reset}          refuse request n
  ${C.bold}/skills [filter]${C.reset}    project, user and plugin skills (Tab completes after /)
  ${C.bold}/<skill> @agent text${C.reset}  ask an agent to run a skill (no @: ask the room)
  ${C.bold}/detach${C.reset}            detach from the workspace (agents and room keep running)
  ${C.bold}/close yes${C.reset}         close the room's panes and sessions (history and charter stay)
  ${C.bold}/paste${C.reset}             paste the clipboard: image, copied file or text (same as Ctrl+V)
  ${C.bold}/file <path>${C.reset}       attach a file (image, pdf or text)
  ${C.bold}/drop <n>${C.reset}          remove item n ([Image #n], [Pasted #n]) from the draft
  ${C.bold}/show${C.reset}              list what is pasted and attached in the draft
  ${C.bold}/clear${C.reset}             discard the draft
  ${C.bold}/reload${C.reset}            restart this console with the ai-room now on disk
  ${C.bold}/help${C.reset}              this help
  ${C.bold}/quit${C.reset}              leave the console (agents keep running)

Any other line goes to the room as your message. With a lead, it wakes the lead
alone; start it with @codex (or @codex @agy) for someone else, @all for everyone.
`;

/**
 * What the human is about to send. Typing and Enter behave exactly as before;
 * a paste lands here instead of being chopped into one message per line, so
 * what leaves the console is one message with its line breaks intact.
 */
export const CONSOLE_COMMANDS = [
  "attach", "agents", "all", "who", "panes", "hide", "show", "remove", "add", "approve", "allow", "deny", "skills", "reload",
  "detach", "close", "paste", "file", "drop", "clear", "help", "quit",
];

/**
 * Tab after "/" completes console commands and skill names. Only the command
 * word is completed; the rest of the line is the human's.
 */
export function completeSlash(line: string, skills: readonly Pick<Skill, "name">[]): [string[], string] {
  if (!line.startsWith("/") || /\s/.test(line)) return [[], line];
  const words = [...new Set([...CONSOLE_COMMANDS, ...skills.map((skill) => skill.name)])].map((word) => `/${word}`);
  const hits = words.filter((word) => word.startsWith(line));
  return [hits.length ? hits : words, line];
}

type DraftItem = { kind: "paste"; text: string } | { kind: "file"; attachment: AttachmentInfo };

/** "[Pasted #2: 480 lines]", "[Image #1]", "[File #3: log.txt]": one per paste or attachment. */
const TOKEN = /\[(?:Pasted|Image|File|PDF) #(\d+)(?:: [^\]]*)?\]/g;

/**
 * What the human is about to send. A paste or an attachment enters the line
 * as a token where the cursor is, as in Claude Code and Codex, so the human
 * writes around it; Enter puts each paste's text back in its place and sends
 * the attachments along. An item whose token was deleted from the line is not
 * sent.
 */
export class Composer {
  private readonly items = new Map<number, DraftItem>();
  private next = 1;

  /** The token that stands for a paste in the line. */
  stage(paste: string): string {
    // A paste usually ends with the newline that closed its last line.
    const text = paste.replace(/\n+$/, "");
    const id = this.next++;
    this.items.set(id, { kind: "paste", text });
    return this.tokenOf(id)!;
  }

  attach(attachment: AttachmentInfo): string {
    const id = this.next++;
    this.items.set(id, { kind: "file", attachment });
    return this.tokenOf(id)!;
  }

  tokenOf(id: number): string | null {
    const item = this.items.get(id);
    if (!item) return null;
    if (item.kind === "paste") {
      const lines = item.text.split("\n").length;
      return lines > 1 ? `[Pasted #${id}: ${lines} lines]` : `[Pasted #${id}: ${item.text.length} chars]`;
    }
    const { mime, name } = item.attachment;
    if (mime.startsWith("image/")) return `[Image #${id}]`;
    return mime === "application/pdf" ? `[PDF #${id}: ${name}]` : `[File #${id}: ${name}]`;
  }

  get empty(): boolean {
    return this.items.size === 0;
  }

  /** How many characters Backspace should remove: a whole token when one ends at the cursor. */
  backspaceWidth(beforeCursor: string): number {
    for (const id of this.items.keys()) {
      const token = this.tokenOf(id)!;
      if (beforeCursor.endsWith(token)) return token.length;
    }
    return 1;
  }

  drop(id: number): string | null {
    const token = this.tokenOf(id);
    this.items.delete(id);
    return token;
  }

  list(): string[] {
    return [...this.items.entries()].map(([id, item]) =>
      item.kind === "paste" ? `${this.tokenOf(id)}  ${item.text.split("\n")[0].slice(0, 60)}` : `${this.tokenOf(id)}  ${formatBytes(item.attachment.bytes)}`
    );
  }

  clear(): void {
    this.items.clear();
  }

  /** The line as the message Enter sends: pastes in place, attachments along. */
  takeAll(line: string): { message: string; attachmentIds: string[] } {
    const attachmentIds: string[] = [];
    const message = line
      .replace(TOKEN, (token, idText: string) => {
        const id = Number(idText);
        const item = this.items.get(id);
        if (!item || this.tokenOf(id) !== token) return token;
        if (item.kind === "paste") return item.text.includes("\n") ? `\n${item.text}\n` : item.text;
        attachmentIds.push(item.attachment.id);
        return `[${item.attachment.mime.startsWith("image/") ? "image" : "file"}: ${item.attachment.name}]`;
      })
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .trim();
    this.clear();
    return { message, attachmentIds };
  }
}

const CONFIRMATIONS = new Set(["sim", "yes", "y", "s", "--confirm", "confirmar"]);

export function closeConfirmed(args: string[]): boolean {
  return args.some((arg) => CONFIRMATIONS.has(arg.toLowerCase()));
}

export type ConsoleCloseResult =
  | { status: "needs-confirmation" }
  | { status: "closed"; sessions: string[] }
  | { status: "nothing" };

/**
 * `/close` is destructive for the processes, so it asks first. The lifecycle
 * itself stays in closeRoom(): the console must not grow a second, divergent
 * idea of what a room owns.
 */
export function closeFromConsole(
  room: string,
  options: { confirmed: boolean; driver?: MultiplexerDriver | null }
): ConsoleCloseResult {
  if (!options.confirmed) return { status: "needs-confirmation" };
  const closed = closeRoom(room, options.driver !== undefined ? { driver: options.driver } : {});
  return closed.length
    ? { status: "closed", sessions: closed.map((entry) => entry.session) }
    : { status: "nothing" };
}

export type AttachTarget =
  | { kind: "pane"; paneId: string; session: string }
  | { kind: "session"; session: string }
  | { kind: "missing" };

/**
 * Where an agent actually lives right now. In workspace mode it is a pane, not
 * a session: looking only for a per-agent session made /attach report every
 * agent the pane workspace launched as nonexistent. The per-agent session is
 * still the answer for `open --detached` and for screen.
 */
export function resolveAttachTarget(
  room: string,
  agent: string,
  driver: MultiplexerDriver
): AttachTarget {
  const workspace = workspaceName(room);
  if (driver.name === "tmux" && sessionExists(driver, workspace)) {
    const paneId = agentPane(driver, workspace, agent);
    if (paneId) return { kind: "pane", paneId, session: workspace };
  }
  const session = sessionName(room, agent);
  return liveSessions(driver).includes(session) ? { kind: "session", session } : { kind: "missing" };
}

export async function runConsole(
  room: string,
  options: { baseUrl: string; agent?: string }
): Promise<void> {
  const me = options.agent ?? "human";
  const driver = detectMultiplexer();

  // Pastes are pulled out of the stream before readline sees them: readline
  // drops the markers and splits on every newline, which turned one paste into
  // one message per line.
  const interactive = Boolean(process.stdin.isTTY);
  const composer = new Composer();
  // readline is created after the stream, so the width is looked up late.
  let backspaceWidth = () => 1;
  const pasteStream = interactive ? createPasteStream({ backspaceWidth: () => backspaceWidth() }) : null;
  if (pasteStream) {
    process.stdin.setRawMode?.(true);
    process.stdin.pipe(pasteStream);
    process.stdout.write(ENABLE_BRACKETED_PASTE);
  }

  // Inside the workspace the status lives on this pane's border instead of the
  // chat; the running tmux reloads the config that knows how to show it.
  const statusPane = process.env.TMUX_PANE && driver?.name === "tmux" && insideWorkspaceServer() ? process.env.TMUX_PANE : null;
  if (statusPane) reloadTmuxConfig(driver!);

  // A console runs the code it started with; an upgrade on disk never reaches
  // it. It notices, says so once, and /reload restarts it in the same pane.
  const codeFile = fileURLToPath(import.meta.url);
  const codeTime = () => {
    try {
      return fs.statSync(codeFile).mtimeMs;
    } catch {
      return 0;
    }
  };
  const startedWith = codeTime();
  let staleNoticed = false;
  const staleTimer = setInterval(() => {
    if (staleNoticed || codeTime() <= startedWith) return;
    staleNoticed = true;
    emit(rl, `${C.warn}ai-room was upgraded; ${C.bold}/reload${C.reset}${C.warn} to run the new version in this console.${C.reset}`);
  }, 30_000);
  staleTimer.unref();

  // Read once: skills are files on disk, and /skills rescans when asked.
  let skills: Skill[] = [];
  const rescanSkills = () => {
    try {
      skills = discoverSkills();
    } catch {
      skills = [];
    }
    return skills;
  };
  rescanSkills();

  const rl = readline.createInterface({
    input: pasteStream ?? process.stdin,
    output: process.stdout,
    prompt: `${C.human}${me}>${C.reset} `,
    terminal: true,
    completer: (line: string) => completeSlash(line, skills),
  });
  backspaceWidth = () => composer.backspaceWidth(rl.line.slice(0, rl.cursor));


  const stopBracketedPaste = () => {
    if (pasteStream) process.stdout.write(DISABLE_BRACKETED_PASTE);
  };
  process.on("exit", stopBracketedPaste);

  console.log(`${C.bold}ai-room console${C.reset} — room ${C.bold}${room}${C.reset}`);
  console.log(
    `${C.dim}multiplexer: ${driver?.name ?? `none (${INSTALL_HINT})`} · /help for commands${C.reset}`
  );
  console.log(`${C.dim}detach: ${DETACH_KEYS} or /detach · close the room: Ctrl-b x or /close yes${C.reset}\n`);

  const workspace = workspaceName(room);

  // Hand the terminal over. readline is paused so the child owns the TTY, and
  // the console resumes exactly where it left off on detach.
  const handOver = (label: string, run: () => void) => {
    emit(rl, `${C.dim}attaching to ${label}…${C.reset}`);
    rl.pause();
    // The child owns the terminal while it runs, including its own paste mode.
    stopBracketedPaste();
    process.stdin.unpipe?.(pasteStream ?? undefined);
    process.stdin.setRawMode?.(false);
    run();
    if (pasteStream) {
      process.stdin.setRawMode?.(true);
      process.stdin.pipe(pasteStream);
      process.stdout.write(ENABLE_BRACKETED_PASTE);
    }
    emit(rl, `${C.dim}back in the console.${C.reset}`);
    rl.resume();
    rl.prompt(true);
  };

  const attach = (agent: string) => {
    if (!driver) {
      emit(rl, `${C.warn}No multiplexer. ${INSTALL_HINT}${C.reset}`);
      return;
    }

    const target = resolveAttachTarget(room, agent, driver);

    if (target.kind === "pane") {
      const focused = focusPane(driver, target.paneId);
      if (!focused.ok) {
        emit(rl, `${C.warn}could not focus ${agent}: ${focused.error}${C.reset}`);
        return;
      }
      if (insideWorkspaceServer()) {
        emit(rl, `${C.dim}focused ${agent}'s pane. back with ${DETACH_KEYS.split(" ·")[0]}.${C.reset}`);
        return;
      }
      if (!canAttach()) {
        emit(rl, `${C.dim}${agent}'s pane selected. attach with: tmux attach -t ${workspace}${C.reset}`);
        return;
      }
      handOver(agent, () => attachWorkspace(driver, workspace));
      return;
    }

    if (target.kind === "missing") {
      emit(rl, `${C.warn}No pane or session for "${agent}". /agents lists what is live.${C.reset}`);
      return;
    }
    const { session } = target;
    handOver(agent, () => {
      spawnSync(driver.bin(), [...driver.base(), ...(driver.name === "tmux" ? ["attach", "-t", session] : ["-r", session])], {
        stdio: "inherit",
      });
    });
  };

  const detach = () => {
    if (!driver || driver.name !== "tmux") {
      emit(rl, `${C.warn}Detaching from here works in tmux only. Use ${DETACH_KEYS}.${C.reset}`);
      return;
    }
    const result = detachWorkspace(driver, workspace);
    emit(
      rl,
      result.ok
        ? `${C.dim}workspace detached. agents and room keep running.${C.reset}`
        : `${C.warn}nothing to detach: ${result.error}${C.reset}`
    );
  };

  const close = (args: string[]) => {
    const result = closeFromConsole(room, { confirmed: closeConfirmed(args), driver });
    if (result.status === "needs-confirmation") {
      emit(
        rl,
        `${C.warn}/close stops this room's panes and sessions (this console included).${C.reset}\n` +
          `${C.dim}history and charter stay in the database. confirm with${C.reset} ${C.bold}/close yes${C.reset}`
      );
      return;
    }
    if (result.status === "nothing") {
      emit(rl, `${C.dim}no live session for "${room}".${C.reset}`);
      return;
    }
    emit(rl, `${C.dim}closed: ${result.sessions.join(", ")}${C.reset}`);
  };

  /**
   * `/<skill> @agent text` types the skill into that agent's pane, the way its
   * harness runs one; without `@agent` the room is asked, and whoever fits
   * picks it up.
   */
  const requestSkill = (skill: Skill, words: string[]) => {
    const target = words.find((word) => word.startsWith("@"))?.slice(1);
    const text = words.filter((word) => !word.startsWith("@")).join(" ");
    if (!target) {
      void say({
        message: `The human asks for the skill \`${skill.name}\`${text ? `: ${text}` : ""}. Whoever has the role for it, run it.`,
        attachmentIds: [],
      });
      return;
    }
    const harness = harnessFor(target);
    const invocation = skillLine(harness, skill.name, text);
    if (!invocation) {
      emit(rl, `${C.warn}don't know how ${target} runs skills; ask the room without @.${C.reset}`);
      return;
    }
    if (!skillVisibleTo(harness, skill)) {
      emit(rl, `${C.warn}${target} cannot see ${skill.name} (it is in ${skill.origin}); ask another agent, or the room without @.${C.reset}`);
      return;
    }
    const pane = driver && driver.name === "tmux" && sessionExists(driver, workspace)
      ? paneStates(driver, workspace).find((state) => state.agent === target)
      : undefined;
    if (!pane) {
      emit(rl, `${C.warn}no pane for ${target} in this workspace.${C.reset}`);
      return;
    }
    const typed = typeIntoPane(driver!, pane.paneId, invocation.line, { closeMenu: invocation.closeMenu });
    emit(
      rl,
      typed.ok
        ? `${C.dim}→ ${target}: ${invocation.line}${C.reset}`
        : `${C.warn}could not type into ${target}'s pane: ${typed.error}${C.reset}`
    );
  };

  const listAgents = () => {
    if (!driver) {
      emit(rl, `${C.warn}No multiplexer. ${INSTALL_HINT}${C.reset}`);
      return;
    }
    const panes =
      driver.name === "tmux" && sessionExists(driver, workspace)
        ? listTaggedPanes(driver, workspace)
        : [];
    const prefix = sessionName(room, "");
    const live = liveSessions(driver).filter((s) => s.startsWith(prefix.slice(0, -1)));
    const lines = [
      panes.length ? `${C.dim}panes:${C.reset} ${panes.map((p) => `${p.agent} (${p.paneId})`).join("  ")}` : "",
      live.length ? `${C.dim}sessions:${C.reset} ${live.join("  ")}` : "",
    ].filter(Boolean);
    emit(rl, lines.join("\n") || `${C.dim}nothing live in this room.${C.reset}`);
  };

  // The console writes approvals and plans itself; this brings back whoever they are for.
  const wakeRoom = () =>
    void fetch(`${options.baseUrl}/wake`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room }),
    }).catch(() => undefined);

  const say = async (draft: { message: string; attachmentIds: string[] }) => {
    try {
      const response = await fetch(`${options.baseUrl}/say`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room, agent: me, message: draft.message, attachmentIds: draft.attachmentIds }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        emit(rl, `${C.warn}not sent: ${body.error ?? response.status}${C.reset}`);
      }
    } catch (error) {
      emit(rl, `${C.warn}server unreachable: ${error instanceof Error ? error.message : error}${C.reset}`);
    }
  };

  // Uploaded as soon as it is staged, so a bad file is refused while the
  // human is still composing; Enter then only ties the ids to the message.
  const upload = async (bytes: Buffer, name: string) => {
    try {
      const response = await fetch(
        `${options.baseUrl}/attachments?room=${encodeURIComponent(room)}&name=${encodeURIComponent(name)}`,
        { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: new Uint8Array(bytes) }
      );
      const body = (await response.json().catch(() => ({}))) as { attachment?: AttachmentInfo; error?: string };
      if (!response.ok || !body.attachment) {
        emit(rl, `${C.warn}attachment refused: ${body.error ?? response.status}${C.reset}`);
        return;
      }
      rl.write(composer.attach(body.attachment));
    } catch (error) {
      emit(rl, `${C.warn}server unreachable: ${error instanceof Error ? error.message : error}${C.reset}`);
    }
  };

  const attachFile = (file: string) => {
    try {
      const { bytes, name } = readAttachableFile(file);
      void upload(bytes, name);
    } catch (error) {
      emit(rl, `${C.warn}could not attach: ${error instanceof Error ? error.message : error}${C.reset}`);
    }
  };

  // A token enters the line where the cursor is; Backspace takes it out whole.
  const stagePaste = (paste: string) => rl.write(composer.stage(paste));

  // Ctrl+V pastes whatever the clipboard holds: an image or a copied file
  // becomes an attachment, text lands in the draft like any paste.
  const attachClipboard = () => {
    const clip = readClipboard();
    if (clip.kind === "image") void upload(clip.bytes, clip.name);
    else if (clip.kind === "file") attachFile(clip.path);
    else if (clip.kind === "text") {
      if (clip.text.trim()) stagePaste(normalizePaste(clip.text));
    } else emit(rl, `${C.dim}${clip.reason}${C.reset}`);
  };

  pasteStream?.on("clipboard", attachClipboard);

  pasteStream?.on("paste", (paste: string) => {
    if (!paste.trim()) return;
    const dropped = pastedFilePath(paste);
    if (dropped) {
      attachFile(dropped);
      return;
    }
    stagePaste(paste);
  });

  // --- live feed -----------------------------------------------------------
  let alerted = "";
  // With a lead the human hears one voice; teammates' messages stay in the
  // room, and /all brings them back here.
  let leads = new Set<string>();
  let showAll = false;
  const controller = new AbortController();

  let lastMessageId = 0;
  const stream = async () => {
    const resume = lastMessageId ? `&after=${lastMessageId}` : "";
    const response = await fetch(`${options.baseUrl}/stream?room=${encodeURIComponent(room)}&agent=${encodeURIComponent(me)}${resume}`, {
      signal: controller.signal,
      headers: { Accept: "text/event-stream" },
    });
    if (!response.body) throw new Error("stream has no body");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const event = frame.match(/^event: (.+)$/m)?.[1];
        const raw = frame.match(/^data: (.+)$/m)?.[1];
        if (!event || !raw) continue;
        let payload: unknown;
        try {
          payload = JSON.parse(raw);
        } catch {
          continue;
        }

        if (event === "message") {
          const message = payload as MessageInfo;
          lastMessageId = Math.max(lastMessageId, message.id);
          // Don't echo the line the user just typed back at them.
          // With a lead, the human hears the lead talking to the human or the whole room.
          const aside =
            message.origin === "agent" &&
            leads.size > 0 &&
            (!leads.has(message.agent) || Boolean(message.to?.length && !message.to.includes(me)));
          if (!(message.origin === "human" && message.agent === me) && (showAll || !aside)) {
            emit(rl, renderMessage(message));
          }
        } else if (event === "status") {
          const participants = payload as ParticipantView[];
          leads = new Set(participants.filter((p) => p.active && p.role?.split(/,\s*/).includes("lead")).map((p) => p.agent));
          if (statusPane) {
            const parts = statusParts(participants);
            mux(driver!, ["set-option", "-p", "-t", statusPane, STATUS_TAG, parts.length ? toTmuxStyle(parts.join("  ")) : "#[dim]room is empty"]);
          } else emit(rl, renderStatus(participants));
          const stuck = needsAttention(participants);
          const fingerprint = stuck.map((p) => `${p.agent}:${p.status}`).join(",");
          if (fingerprint && fingerprint !== alerted) {
            for (const p of stuck) {
              emit(
                rl,
                `${C.alert}${C.bold}→ ${p.agent} needs you${C.reset} ${C.dim}(${p.status})${C.reset}  ` +
                  `use ${C.bold}/attach ${p.agent}${C.reset}`
              );
            }
          }
          alerted = fingerprint;
        }
      }
    }
  };

  // The server restarts (an upgrade, a crash, the Mac waking up) and the feed
  // ends with it; without reconnecting, the monitor went silent while the room
  // kept talking. It resumes after the last message it showed, so nothing
  // repeats and nothing is skipped.
  const follow = async () => {
    let delay = 1_000;
    let announced = false;
    while (!controller.signal.aborted) {
      try {
        await stream();
        delay = 1_000;
      } catch (error) {
        if (controller.signal.aborted) return;
        if (!announced) {
          emit(rl, `${C.warn}feed lost (${error instanceof Error ? error.message : error}); reconnecting…${C.reset}`);
          announced = true;
        }
      }
      if (controller.signal.aborted) return;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 10_000);
      if (announced) {
        const up = await fetch(`${options.baseUrl}/health`).then((r) => r.ok).catch(() => false);
        if (up) {
          emit(rl, `${C.dim}feed reconnected.${C.reset}`);
          announced = false;
        }
      }
    }
  };
  void follow();

  // --- input ---------------------------------------------------------------
  rl.prompt();

  rl.on("line", (line) => {
    const text = line.trim();
    // Enter with something staged sends it, even with nothing typed. Enter on
    // an empty prompt with nothing staged still does nothing, as before.
    if (!text) {
      // Every token deleted: nothing of the draft is on the line any more.
      composer.clear();
      return rl.prompt();
    }

    if (text.startsWith("/")) {
      const [cmd, ...rest] = text.slice(1).split(/\s+/);
      switch (cmd) {
        case "attach":
          if (!rest[0]) emit(rl, `${C.warn}usage: /attach <agent>${C.reset}`);
          else attach(rest[0]);
          break;
        case "agents":
          listAgents();
          break;
        case "all":
          showAll = !showAll;
          emit(rl, `${C.dim}${showAll ? "showing every agent's messages" : leads.size ? `showing only the lead (${[...leads].join(", ")})` : "no lead in this room: every message shows"}${C.reset}`);
          break;
        case "who":
          void fetch(`${options.baseUrl}/who?room=${encodeURIComponent(room)}`)
            .then((r) => r.json())
            .then((d) => {
              const participants = (d as { participants?: ParticipantView[] }).participants ?? [];
              emit(rl, participants.map((p) => renderParticipant(p)).join("  ") || `${C.dim}room is empty${C.reset}`);
            })
            .catch(() => emit(rl, `${C.warn}server unreachable${C.reset}`));
          break;
        case "panes":
        case "hide":
        case "show": {
          // Bare /show is the draft; /show <pane> is a pane.
          if (cmd === "show" && !rest[0]) {
            emit(
              rl,
              composer.empty
                ? `${C.dim}nothing pasted or attached in the draft.${C.reset}`
                : `${C.dim}in the draft:${C.reset}\n${composer.list().map((item) => `  ${item}`).join("\n")}`
            );
            break;
          }
          if (!driver || driver.name !== "tmux" || !sessionExists(driver, workspace)) {
            emit(rl, `${C.warn}no tmux workspace for this room.${C.reset}`);
            break;
          }
          if (cmd === "panes") {
            const states = paneStates(driver, workspace);
            emit(rl, states.map((p) => `${p.hidden ? C.dim + "[ ]" : "[x]"} ${p.agent}${C.reset}`).join("  ") || `${C.dim}no panes.${C.reset}`);
            break;
          }
          if (!rest[0]) {
            emit(rl, `${C.warn}usage: /${cmd} <pane>${C.reset}`);
            break;
          }
          const result = setPaneVisible(driver, workspace, rest[0], cmd);
          emit(rl, result.ok ? `${C.dim}${rest[0]}: ${result.hidden ? "hidden" : "visible"}${C.reset}` : `${C.warn}${result.error}${C.reset}`);
          break;
        }
        case "approve":
          void Promise.all([import("./cast.js"), import("./db/index.js")]).then(([cast, dbModule]) => {
            const db = dbModule.openDb();
            try {
              const result = cast.approvePlan(db, room);
              emit(rl, result.ok ? `${C.dim}${result.detail}${C.reset}` : `${C.warn}${result.detail}${C.reset}`);
              if (result.ok) wakeRoom();
            } finally {
              db.close();
            }
          });
          break;
        case "allow":
        case "deny":
          void Promise.all([import("./approvals.js"), import("./db/index.js")]).then(([approvals, dbModule]) => {
            const db = dbModule.openDb();
            try {
              const pending = approvals.pendingApprovals(db, room);
              // A bare /allow only lists: approving has to name the request.
              const id = Number(rest[0] ?? NaN);
              if (!Number.isInteger(id)) {
                emit(
                  rl,
                  pending.length
                    ? `${C.dim}waiting for you:${C.reset}\n${pending.map((a) => `  #${a.id} ${a.agent}: ${a.action}${a.reason ? ` ${C.dim}(${a.reason})${C.reset}` : ""}`).join("\n")}\n${C.dim}/allow <n> or /deny <n>${C.reset}`
                    : `${C.dim}nothing waiting for your approval.${C.reset}`
                );
                return;
              }
              const decided = approvals.decideApproval(db, room, id, cmd === "allow");
              if (!decided) {
                emit(rl, `${C.warn}no open request #${id} in this room${C.reset}`);
                return;
              }
              emit(rl, `${C.dim}${cmd === "allow" ? "allowed once" : "denied"}: #${id} ${decided.agent}: ${decided.action}${C.reset}`);
              wakeRoom();
            } finally {
              db.close();
            }
          });
          break;
        case "remove":
        case "add": {
          if (!rest[0]) {
            emit(rl, `${C.warn}usage: /${cmd} <agent>${cmd === "add" ? " [role]" : ""}${C.reset}`);
            break;
          }
          void Promise.all([import("./cast.js"), import("./db/index.js")]).then(([cast, dbModule]) => {
            const db = dbModule.openDb();
            try {
              if (cmd === "remove") {
                const result = cast.removeAgent(db, room, rest[0]);
                emit(rl, result.ok ? `${C.dim}${result.detail}${C.reset}` : `${C.warn}${result.detail}${C.reset}`);
                return;
              }
              // `/add codex sim` confirms another instance; any other words are the role.
              const words = rest.slice(1);
              const confirmed = words.some((word) => CONFIRMATIONS.has(word.toLowerCase()));
              const role = words.filter((word) => !CONFIRMATIONS.has(word.toLowerCase())).join(" ") || undefined;
              const result = cast.addAgent(db, room, rest[0], role, { confirmed });
              if (result.ok) emit(rl, `${C.dim}${result.detail}${C.reset}`);
              else if (result.confirm) {
                emit(
                  rl,
                  `${C.warn}${rest[0]} is already in the room.${C.reset} ${C.dim}another instance spends its own tokens; confirm with${C.reset} ` +
                    `${C.bold}/add ${rest[0]}${role ? ` ${role}` : ""} yes${C.reset} ${C.dim}to open ${result.confirm}, or ${C.reset}${C.bold}/remove ${rest[0]}${C.reset}${C.dim} first to replace it${C.reset}`
                );
              } else emit(rl, `${C.warn}${result.detail}${C.reset}`);
            } finally {
              db.close();
            }
          });
          break;
        }
        case "skills": {
          const filter = rest.join(" ").toLowerCase();
          const found = rescanSkills().filter(
            (skill) => !filter || skill.name.toLowerCase().includes(filter) || skill.description.toLowerCase().includes(filter)
          );
          emit(rl, renderSkills(found));
          break;
        }
        case "reload": {
          // respawn-pane restarts the pane's own command, so the monitor comes
          // back as it was launched, with the code now on disk.
          const pane = process.env.TMUX_PANE;
          if (!pane || !driver || driver.name !== "tmux") {
            emit(rl, `${C.warn}/reload works in the workspace pane only; here, /quit and open it again.${C.reset}`);
            break;
          }
          if (!composer.empty) {
            emit(rl, `${C.warn}the draft would be lost; send it with Enter or /clear it before /reload.${C.reset}`);
            break;
          }
          mux(driver, ["respawn-pane", "-k", "-t", pane]);
          break;
        }
        case "detach":
          detach();
          break;
        case "close":
          close(rest);
          break;
        case "paste":
          attachClipboard();
          break;
        case "file":
          if (!rest.length) emit(rl, `${C.warn}uso: /file <caminho>${C.reset}`);
          else attachFile(text.slice(text.indexOf(" ") + 1).trim());
          break;
        case "drop": {
          const dropped = composer.drop(Number(rest[0]));
          emit(rl, dropped ? `${C.dim}removed ${dropped}${C.reset}` : `${C.warn}usage: /drop <n>, the number in the token${C.reset}`);
          break;
        }
        case "clear":
          if (!composer.empty) {
            composer.clear();
            emit(rl, `${C.dim}draft discarded.${C.reset}`);
          } else emit(rl, `${C.dim}nothing to discard.${C.reset}`);
          break;
        case "help":
          emit(rl, HELP);
          break;
        case "quit":
        case "exit":
          rl.close();
          return;
        default: {
          const skill = skills.find((candidate) => candidate.name === cmd);
          if (!skill) {
            emit(rl, `${C.warn}unknown command: /${cmd} — /help, /skills${C.reset}`);
            break;
          }
          requestSkill(skill, rest);
        }
      }
      return rl.prompt();
    }

    // One message, whatever it is made of: typed text, pasted blocks, or both.
    const draft = composer.takeAll(text);
    if (draft.message || draft.attachmentIds.length) void say(draft);
    rl.prompt();
  });

  await new Promise<void>((resolve) => {
    rl.on("close", () => {
      stopBracketedPaste();
      controller.abort();
      console.log(`\n${C.dim}console closed. The agents keep running.${C.reset}`);
      resolve();
    });
  });
}
