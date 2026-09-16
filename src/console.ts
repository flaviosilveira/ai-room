import readline from "node:readline";
import { spawnSync } from "node:child_process";
import {
  INSTALL_HINT,
  detectMultiplexer,
  liveSessions,
  sessionName,
} from "./session.js";
import type { MessageInfo, ParticipantInfo } from "./types.js";

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

function renderStatus(participants: ParticipantInfo[]): string {
  const parts = participants
    .filter((p) => p.active || p.status === "approval_required")
    .map((p) => {
      const color = STATUS_COLOR[p.status] ?? C.dim;
      const detail = p.statusDetail ? ` (${p.statusDetail})` : "";
      return `${color}${p.agent}:${p.status}${detail}${C.reset}`;
    });
  return `${C.dim}${stamp(Date.now())} —${C.reset} ${parts.join("  ") || `${C.dim}sala vazia${C.reset}`}`;
}

/** Agents whose status means a human has to go look at them. */
function needsAttention(participants: ParticipantInfo[]): ParticipantInfo[] {
  return participants.filter(
    (p) => p.status === "approval_required" || p.status === "blocked"
  );
}

const HELP = `
${C.bold}Comandos${C.reset}
  ${C.bold}/attach <agente>${C.reset}   anexa à sessão do agente (Ctrl-A D no screen, Ctrl-B D no tmux para voltar)
  ${C.bold}/agents${C.reset}            lista as sessões de agente vivas
  ${C.bold}/who${C.reset}               participantes e status
  ${C.bold}/help${C.reset}              esta ajuda
  ${C.bold}/quit${C.reset}              sai do console (os agentes continuam rodando)

Qualquer outra linha é enviada à sala como mensagem sua.
`;

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
    `${C.dim}multiplexador: ${driver?.name ?? `nenhum (${INSTALL_HINT})`} · /help para comandos${C.reset}\n`
  );

  const attach = (agent: string) => {
    if (!driver) {
      emit(rl, `${C.warn}Sem multiplexador. ${INSTALL_HINT}${C.reset}`);
      return;
    }
    const session = sessionName(room, agent);
    if (!liveSessions(driver).includes(session)) {
      emit(rl, `${C.warn}Sessão "${session}" não existe. Use /agents para ver as vivas.${C.reset}`);
      return;
    }
    // Hand the terminal over. readline is paused so the child owns the TTY,
    // and the console resumes exactly where it left off on detach.
    emit(rl, `${C.dim}anexando a ${agent}…${C.reset}`);
    rl.pause();
    process.stdin.setRawMode?.(false);
    spawnSync(driver.name, driver.name === "tmux" ? ["attach", "-t", session] : ["-r", session], {
      stdio: "inherit",
    });
    emit(rl, `${C.dim}de volta ao console.${C.reset}`);
    rl.resume();
    rl.prompt(true);
  };

  const listAgents = () => {
    if (!driver) {
      emit(rl, `${C.warn}Sem multiplexador. ${INSTALL_HINT}${C.reset}`);
      return;
    }
    const prefix = sessionName(room, "");
    const live = liveSessions(driver).filter((s) => s.startsWith(prefix.slice(0, -1)));
    emit(
      rl,
      live.length
        ? `${C.dim}sessões vivas:${C.reset} ${live.join("  ")}`
        : `${C.dim}nenhuma sessão de agente viva nesta sala.${C.reset}`
    );
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
          const participants = payload as ParticipantInfo[];
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
          void fetch(`${options.baseUrl}/active?agent=${encodeURIComponent(rest[0] ?? me)}`)
            .then((r) => r.json())
            .then((d) => emit(rl, JSON.stringify(d, null, 2)))
            .catch(() => emit(rl, `${C.warn}servidor inacessível${C.reset}`));
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
