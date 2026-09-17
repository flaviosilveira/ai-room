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
  insideMultiplexer,
  liveSessions,
  sessionExists,
  sessionName,
  workspaceName,
} from "./session.js";
import { closeRoom } from "./invite.js";
import { STATUS_STALE_MS } from "./wait.js";
import type { MultiplexerDriver } from "./session.js";
import type { MessageInfo, ParticipantView } from "./types.js";

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

function renderMessage(m: MessageInfo): string {
  const color = m.origin === "human" ? C.human : m.origin === "system" ? C.system : C.agent;
  const who = m.origin === "human" ? `${m.agent} (você)` : m.agent;
  return `${C.dim}${stamp(m.createdAt)}${C.reset} ${color}${C.bold}${who}${C.reset}  ${m.content}`;
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

  if (p.waitActive) {
    return `${C.dim}${p.agent}:wait(live)${C.reset}${unread ? `${C.warn}${unread}${C.reset}` : ""}`;
  }
  const stale = since > staleMs;
  const label =
    p.status === "waiting"
      ? `waiting?${age(since)}`
      : stale
        ? `${p.status}·${age(since)}`
        : p.status;
  const color = p.status === "waiting" ? C.warn : STATUS_COLOR[p.status] ?? C.dim;
  const detail = p.statusDetail ? ` (${p.statusDetail})` : "";
  return `${color}${p.agent}:${label}${detail}${C.reset}${unread ? `${C.warn}${unread}${C.reset}` : ""}`;
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

/** tmux binds detach to lowercase `d`; `Ctrl-b D` is choose-client and looks like nothing happened. */
export const DETACH_KEYS = "Ctrl-b d (tmux) · Ctrl-a d (screen)";

export const HELP = `
${C.bold}Comandos${C.reset}
  ${C.bold}/attach <agente>${C.reset}   foca o pane do agente (volta com ${DETACH_KEYS})
  ${C.bold}/agents${C.reset}            lista panes e sessões vivas da sala
  ${C.bold}/who${C.reset}               participantes, wait ativo e não lidas
  ${C.bold}/detach${C.reset}            desanexa o workspace (agentes e sala seguem vivos)
  ${C.bold}/close sim${C.reset}         encerra panes e sessões da sala (histórico e charter ficam)
  ${C.bold}/help${C.reset}              esta ajuda
  ${C.bold}/quit${C.reset}              sai do console (os agentes continuam rodando)

Qualquer outra linha é enviada à sala como mensagem sua.
`;

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

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${C.human}${me}>${C.reset} `,
  });

  console.log(`${C.bold}ai-room console${C.reset} — sala ${C.bold}${room}${C.reset}`);
  console.log(
    `${C.dim}multiplexador: ${driver?.name ?? `nenhum (${INSTALL_HINT})`} · /help para comandos${C.reset}`
  );
  console.log(`${C.dim}detach: ${DETACH_KEYS} ou /detach · encerrar a sala: /close sim${C.reset}\n`);

  const workspace = workspaceName(room);

  // Hand the terminal over. readline is paused so the child owns the TTY, and
  // the console resumes exactly where it left off on detach.
  const handOver = (label: string, run: () => void) => {
    emit(rl, `${C.dim}anexando a ${label}…${C.reset}`);
    rl.pause();
    process.stdin.setRawMode?.(false);
    run();
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
      if (insideMultiplexer()) {
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
      spawnSync(driver.name, driver.name === "tmux" ? ["attach", "-t", session] : ["-r", session], {
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

  const say = async (text: string) => {
    try {
      const response = await fetch(`${options.baseUrl}/say`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room, agent: me, message: text }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        emit(rl, `${C.warn}não enviado: ${body.error ?? response.status}${C.reset}`);
      }
    } catch (error) {
      emit(rl, `${C.warn}servidor inacessível: ${error instanceof Error ? error.message : error}${C.reset}`);
    }
  };

  // --- live feed -----------------------------------------------------------
  let alerted = "";
  const controller = new AbortController();

  const stream = async () => {
    const response = await fetch(`${options.baseUrl}/stream?room=${encodeURIComponent(room)}`, {
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

  stream().catch((error) => {
    if (controller.signal.aborted) return;
    emit(rl, `${C.warn}feed interrompido: ${error instanceof Error ? error.message : error}${C.reset}`);
  });

  // --- input ---------------------------------------------------------------
  rl.prompt();

  rl.on("line", (line) => {
    const text = line.trim();
    if (!text) return rl.prompt();

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
        case "detach":
          detach();
          break;
        case "close":
          close(rest);
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

    void say(text);
    rl.prompt();
  });

  await new Promise<void>((resolve) => {
    rl.on("close", () => {
      controller.abort();
      console.log(`\n${C.dim}console encerrado. Os agentes continuam rodando.${C.reset}`);
      resolve();
    });
  });
}
