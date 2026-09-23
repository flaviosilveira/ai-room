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
  paneStates,
  sessionExists,
  sessionName,
  setPaneVisible,
  workspaceName,
} from "./session.js";
import { closeRoom } from "./invite.js";
import { STATUS_STALE_MS } from "./wait.js";
import {
  DISABLE_BRACKETED_PASTE,
  ENABLE_BRACKETED_PASTE,
  createPasteStream,
} from "./paste.js";
import { formatBytes } from "./attachments.js";
import { pastedFilePath, readAttachableFile, readClipboard } from "./clipboard.js";
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
  readline.cursorTo(process.stdout, 0);
  readline.clearLine(process.stdout, 0);
  process.stdout.write(`${line}\n`);
  rl.prompt(true);
}

export function attachmentChip(a: Pick<AttachmentInfo, "name" | "mime" | "bytes">): string {
  const kind = a.mime.startsWith("image/") ? "img" : a.mime === "application/pdf" ? "pdf" : "file";
  return `[${kind} ${a.name} ${formatBytes(a.bytes)}]`;
}

function renderMessage(m: MessageInfo): string {
  const color = m.origin === "human" ? C.human : m.origin === "system" ? C.system : C.agent;
  const who = m.origin === "human" ? `${m.agent} (você)` : m.agent;
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

function renderStatus(participants: ParticipantView[]): string {
  const parts = participants
    .filter((p) => p.active || p.status === "approval_required")
    .map((p) => renderParticipant(p));
  return `${C.dim}${stamp(Date.now())} —${C.reset} ${parts.join("  ") || `${C.dim}sala vazia${C.reset}`}`;
}

/** Agents whose status means a human has to go look at them. */
function needsAttention(participants: ParticipantView[]): ParticipantView[] {
  return participants.filter(
    (p) => p.status === "approval_required" || p.status === "blocked"
  );
}

/** The workspace's own tmux server binds all of these; screen keeps its default. */
export const DETACH_KEYS = "F12 · Ctrl-b d · Ctrl-b Ctrl-d (tmux) · Ctrl-a d (screen)";

export const HELP = `
${C.bold}Comandos${C.reset}
  ${C.bold}/attach <agente>${C.reset}   foca o pane do agente (volta com ${DETACH_KEYS})
  ${C.bold}/agents${C.reset}            lista panes e sessões vivas da sala
  ${C.bold}/who${C.reset}               participantes: idle/working/wait(live) e não lidas
  ${C.bold}/panes${C.reset}             panes do workspace e quais estão visíveis (files é a aba 1: Ctrl-b t)
  ${C.bold}/hide <pane>${C.reset}       esconde um pane (agente, monitor ou files) sem pará-lo
  ${C.bold}/show <pane>${C.reset}       mostra de novo um pane escondido
  ${C.bold}/remove <agente>${C.reset}    tira um agente da sala (ex.: bateu no limite); os outros seguem
  ${C.bold}/add <agente> [papel]${C.reset} traz um agente (novo ou de volta) para a sala
  ${C.bold}/detach${C.reset}            desanexa o workspace (agentes e sala seguem vivos)
  ${C.bold}/close sim${C.reset}         encerra panes e sessões da sala (histórico e charter ficam)
  ${C.bold}/paste${C.reset}             anexa a imagem do clipboard (o mesmo que Ctrl+V)
  ${C.bold}/file <caminho>${C.reset}    anexa um arquivo (imagem, pdf ou texto)
  ${C.bold}/drop <n>${C.reset}          remove o anexo n do rascunho
  ${C.bold}/show${C.reset}              mostra o que está colado e anexado no rascunho
  ${C.bold}/clear${C.reset}             descarta o rascunho
  ${C.bold}/help${C.reset}              esta ajuda
  ${C.bold}/quit${C.reset}              sai do console (os agentes continuam rodando)

Qualquer outra linha é enviada à sala como mensagem sua.
`;

/**
 * What the human is about to send. Typing and Enter behave exactly as before;
 * a paste lands here instead of being chopped into one message per line, so
 * what leaves the console is one message with its line breaks intact.
 */
export class Composer {
  private readonly pastes: string[] = [];
  private readonly files: AttachmentInfo[] = [];

  attach(attachment: AttachmentInfo): void {
    this.files.push(attachment);
  }

  get attachments(): readonly AttachmentInfo[] {
    return this.files;
  }

  /** 1-based, as the draft line shows it. */
  drop(position: number): AttachmentInfo | null {
    if (!Number.isInteger(position) || position < 1 || position > this.files.length) return null;
    return this.files.splice(position - 1, 1)[0];
  }

  /** The draft line shown above the prompt while anything is attached. */
  draftLine(): string {
    return this.files.map((file, i) => `[${i + 1}] ${attachmentChip(file).slice(1, -1)}`).join(" · ");
  }

  get empty(): boolean {
    return this.pastes.length === 0 && this.files.length === 0;
  }

  stage(paste: string): void {
    // A paste usually ends with the newline that closed its last line; keeping
    // it would put a blank line at the end of every pasted message.
    this.pastes.push(paste.replace(/\n+$/, ""));
  }

  get pending(): number {
    return this.pastes.length;
  }

  /** A one-line receipt for a paste the console will not echo in full. */
  summary(paste: string): string {
    const lines = paste.split("\n").length;
    return `[colado: ${lines} linha${lines === 1 ? "" : "s"}, ${paste.length} chars]`;
  }

  staged(): string {
    return this.pastes.join("\n\n");
  }

  clear(): void {
    this.pastes.length = 0;
    this.files.length = 0;
  }

  /** Typed line plus everything staged, as a single message. */
  compose(typed: string): string {
    return [typed.trim(), ...this.pastes].filter(Boolean).join("\n\n");
  }

  take(typed: string): string {
    return this.takeAll(typed).message;
  }

  /** Everything in the draft, as the one message Enter sends. */
  takeAll(typed: string): { message: string; attachmentIds: string[] } {
    const message = this.compose(typed);
    const attachmentIds = this.files.map((file) => file.id);
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
  const pasteStream = interactive ? createPasteStream() : null;
  if (pasteStream) {
    process.stdin.setRawMode?.(true);
    process.stdin.pipe(pasteStream);
    process.stdout.write(ENABLE_BRACKETED_PASTE);
  }

  const rl = readline.createInterface({
    input: pasteStream ?? process.stdin,
    output: process.stdout,
    prompt: `${C.human}${me}>${C.reset} `,
    terminal: true,
  });

  const stopBracketedPaste = () => {
    if (pasteStream) process.stdout.write(DISABLE_BRACKETED_PASTE);
  };
  process.on("exit", stopBracketedPaste);

  console.log(`${C.bold}ai-room console${C.reset} — sala ${C.bold}${room}${C.reset}`);
  console.log(
    `${C.dim}multiplexador: ${driver?.name ?? `nenhum (${INSTALL_HINT})`} · /help para comandos${C.reset}`
  );
  console.log(`${C.dim}detach: ${DETACH_KEYS} ou /detach · encerrar a sala: Ctrl-b X ou /close sim${C.reset}\n`);

  const workspace = workspaceName(room);

  // Hand the terminal over. readline is paused so the child owns the TTY, and
  // the console resumes exactly where it left off on detach.
  const handOver = (label: string, run: () => void) => {
    emit(rl, `${C.dim}anexando a ${label}…${C.reset}`);
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
    emit(rl, `${C.dim}de volta ao console.${C.reset}`);
    rl.resume();
    rl.prompt(true);
  };

  const attach = (agent: string) => {
    if (!driver) {
      emit(rl, `${C.warn}Sem multiplexador. ${INSTALL_HINT}${C.reset}`);
      return;
    }

    const target = resolveAttachTarget(room, agent, driver);

    if (target.kind === "pane") {
      const focused = focusPane(driver, target.paneId);
      if (!focused.ok) {
        emit(rl, `${C.warn}não foi possível focar ${agent}: ${focused.error}${C.reset}`);
        return;
      }
      if (insideWorkspaceServer()) {
        emit(rl, `${C.dim}foco no pane de ${agent}. volte com ${DETACH_KEYS.split(" ·")[0]}.${C.reset}`);
        return;
      }
      if (!canAttach()) {
        emit(rl, `${C.dim}pane de ${agent} selecionado. anexe com: tmux attach -t ${workspace}${C.reset}`);
        return;
      }
      handOver(agent, () => attachWorkspace(driver, workspace));
      return;
    }

    if (target.kind === "missing") {
      emit(rl, `${C.warn}Nem pane nem sessão para "${agent}". Use /agents para ver o que está vivo.${C.reset}`);
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
      emit(rl, `${C.warn}Detach automático só no tmux. Use ${DETACH_KEYS}.${C.reset}`);
      return;
    }
    const result = detachWorkspace(driver, workspace);
    emit(
      rl,
      result.ok
        ? `${C.dim}workspace desanexado. agentes e sala seguem vivos.${C.reset}`
        : `${C.warn}nada para desanexar: ${result.error}${C.reset}`
    );
  };

  const close = (args: string[]) => {
    const result = closeFromConsole(room, { confirmed: closeConfirmed(args), driver });
    if (result.status === "needs-confirmation") {
      emit(
        rl,
        `${C.warn}/close encerra os panes e sessões desta sala (inclusive este console).${C.reset}\n` +
          `${C.dim}histórico e charter continuam no banco. confirme com${C.reset} ${C.bold}/close sim${C.reset}`
      );
      return;
    }
    if (result.status === "nothing") {
      emit(rl, `${C.dim}nenhuma sessão viva para "${room}".${C.reset}`);
      return;
    }
    emit(rl, `${C.dim}encerrado: ${result.sessions.join(", ")}${C.reset}`);
  };

  const listAgents = () => {
    if (!driver) {
      emit(rl, `${C.warn}Sem multiplexador. ${INSTALL_HINT}${C.reset}`);
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
      live.length ? `${C.dim}sessões:${C.reset} ${live.join("  ")}` : "",
    ].filter(Boolean);
    emit(rl, lines.join("\n") || `${C.dim}nada vivo nesta sala.${C.reset}`);
  };

  const say = async (draft: { message: string; attachmentIds: string[] }) => {
    try {
      const response = await fetch(`${options.baseUrl}/say`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room, agent: me, message: draft.message, attachmentIds: draft.attachmentIds }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        emit(rl, `${C.warn}não enviado: ${body.error ?? response.status}${C.reset}`);
      }
    } catch (error) {
      emit(rl, `${C.warn}servidor inacessível: ${error instanceof Error ? error.message : error}${C.reset}`);
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
        emit(rl, `${C.warn}anexo recusado: ${body.error ?? response.status}${C.reset}`);
        return;
      }
      composer.attach(body.attachment);
      emit(rl, `${C.dim}anexos: ${composer.draftLine()} — Enter envia, /drop n remove${C.reset}`);
    } catch (error) {
      emit(rl, `${C.warn}servidor inacessível: ${error instanceof Error ? error.message : error}${C.reset}`);
    }
  };

  const attachFile = (file: string) => {
    try {
      const { bytes, name } = readAttachableFile(file);
      void upload(bytes, name);
    } catch (error) {
      emit(rl, `${C.warn}não foi possível anexar: ${error instanceof Error ? error.message : error}${C.reset}`);
    }
  };

  const attachClipboard = () => {
    const clip = readClipboard();
    if (clip.kind === "image") void upload(clip.bytes, clip.name);
    else if (clip.kind === "file") attachFile(clip.path);
    else emit(rl, `${C.dim}${clip.reason}${C.reset}`);
  };

  pasteStream?.on("clipboard", attachClipboard);

  pasteStream?.on("paste", (paste: string) => {
    if (!paste.trim()) return;
    const dropped = pastedFilePath(paste);
    if (dropped) {
      attachFile(dropped);
      return;
    }
    composer.stage(paste);
    emit(
      rl,
      `${C.dim}${composer.summary(paste)} — Enter envia, /show inspeciona, /clear descarta${C.reset}`
    );
  });

  // --- live feed -----------------------------------------------------------
  let alerted = "";
  const controller = new AbortController();

  let lastMessageId = 0;
  const stream = async () => {
    const resume = lastMessageId ? `&after=${lastMessageId}` : "";
    const response = await fetch(`${options.baseUrl}/stream?room=${encodeURIComponent(room)}&agent=${encodeURIComponent(me)}${resume}`, {
      signal: controller.signal,
      headers: { Accept: "text/event-stream" },
    });
    if (!response.body) throw new Error("stream sem corpo");

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
          if (!(message.origin === "human" && message.agent === me)) {
            emit(rl, renderMessage(message));
          }
        } else if (event === "status") {
          const participants = payload as ParticipantView[];
          emit(rl, renderStatus(participants));
          const stuck = needsAttention(participants);
          const fingerprint = stuck.map((p) => `${p.agent}:${p.status}`).join(",");
          if (fingerprint && fingerprint !== alerted) {
            for (const p of stuck) {
              emit(
                rl,
                `${C.alert}${C.bold}→ ${p.agent} precisa de você${C.reset} ${C.dim}(${p.status})${C.reset}  ` +
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
          emit(rl, `${C.warn}feed interrompido (${error instanceof Error ? error.message : error}); reconectando…${C.reset}`);
          announced = true;
        }
      }
      if (controller.signal.aborted) return;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 10_000);
      if (announced) {
        const up = await fetch(`${options.baseUrl}/health`).then((r) => r.ok).catch(() => false);
        if (up) {
          emit(rl, `${C.dim}feed reconectado.${C.reset}`);
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
    if (!text && composer.empty) return rl.prompt();

    if (text.startsWith("/")) {
      const [cmd, ...rest] = text.slice(1).split(/\s+/);
      switch (cmd) {
        case "attach":
          if (!rest[0]) emit(rl, `${C.warn}uso: /attach <agente>${C.reset}`);
          else attach(rest[0]);
          break;
        case "agents":
          listAgents();
          break;
        case "who":
          void fetch(`${options.baseUrl}/who?room=${encodeURIComponent(room)}`)
            .then((r) => r.json())
            .then((d) => {
              const participants = (d as { participants?: ParticipantView[] }).participants ?? [];
              emit(rl, participants.map((p) => renderParticipant(p)).join("  ") || `${C.dim}sala vazia${C.reset}`);
            })
            .catch(() => emit(rl, `${C.warn}servidor inacessível${C.reset}`));
          break;
        case "panes":
        case "hide":
        case "show": {
          // Bare /show is the draft; /show <pane> is a pane.
          if (cmd === "show" && !rest[0]) {
            emit(
              rl,
              composer.empty
                ? `${C.dim}nada colado nem anexado no rascunho.${C.reset}`
                : [
                    composer.pending ? `${C.dim}rascunho (${composer.pending} colagem(ns)):${C.reset}\n${composer.staged()}` : "",
                    composer.attachments.length ? `${C.dim}anexos:${C.reset} ${composer.draftLine()}` : "",
                  ].filter(Boolean).join("\n")
            );
            break;
          }
          if (!driver || driver.name !== "tmux" || !sessionExists(driver, workspace)) {
            emit(rl, `${C.warn}sem workspace tmux para esta sala.${C.reset}`);
            break;
          }
          if (cmd === "panes") {
            const states = paneStates(driver, workspace);
            emit(rl, states.map((p) => `${p.hidden ? C.dim + "[ ]" : "[x]"} ${p.agent}${C.reset}`).join("  ") || `${C.dim}nenhum pane.${C.reset}`);
            break;
          }
          if (!rest[0]) {
            emit(rl, `${C.warn}uso: /${cmd} <pane>${C.reset}`);
            break;
          }
          const result = setPaneVisible(driver, workspace, rest[0], cmd);
          emit(rl, result.ok ? `${C.dim}${rest[0]}: ${result.hidden ? "escondido" : "visível"}${C.reset}` : `${C.warn}${result.error}${C.reset}`);
          break;
        }
        case "remove":
        case "add": {
          if (!rest[0]) {
            emit(rl, `${C.warn}uso: /${cmd} <agente>${cmd === "add" ? " [papel]" : ""}${C.reset}`);
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
                  `${C.warn}${rest[0]} já está na sala.${C.reset} ${C.dim}outra instância gasta tokens próprios; confirme com${C.reset} ` +
                    `${C.bold}/add ${rest[0]}${role ? ` ${role}` : ""} sim${C.reset} ${C.dim}para abrir ${result.confirm}, ou ${C.reset}${C.bold}/remove ${rest[0]}${C.reset}${C.dim} antes para trocá-lo${C.reset}`
                );
              } else emit(rl, `${C.warn}${result.detail}${C.reset}`);
            } finally {
              db.close();
            }
          });
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
          emit(
            rl,
            dropped
              ? `${C.dim}removido: ${dropped.name}${composer.attachments.length ? ` · anexos: ${composer.draftLine()}` : ""}${C.reset}`
              : `${C.warn}uso: /drop <n> — anexos: ${composer.draftLine() || "nenhum"}${C.reset}`
          );
          break;
        }
        case "clear":
          if (!composer.empty) {
            composer.clear();
            emit(rl, `${C.dim}rascunho descartado.${C.reset}`);
          } else emit(rl, `${C.dim}nada para descartar.${C.reset}`);
          break;
        case "help":
          emit(rl, HELP);
          break;
        case "quit":
        case "exit":
          rl.close();
          return;
        default:
          emit(rl, `${C.warn}comando desconhecido: /${cmd} — /help${C.reset}`);
      }
      return rl.prompt();
    }

    // One message, whatever it is made of: typed text, pasted blocks, or both.
    void say(composer.takeAll(text));
    rl.prompt();
  });

  await new Promise<void>((resolve) => {
    rl.on("close", () => {
      stopBracketedPaste();
      controller.abort();
      console.log(`\n${C.dim}console encerrado. Os agentes continuam rodando.${C.reset}`);
      resolve();
    });
  });
}
