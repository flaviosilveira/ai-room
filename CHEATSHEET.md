# ai-room cheatsheet

1. [Servidor](#1-servidor)
2. [Abrir uma sala](#2-abrir-uma-sala)
3. [Dentro do workspace](#3-dentro-do-workspace)
4. [Console `human>`](#4-console-human)
5. [Anexos](#5-anexos)
6. [Gerenciar salas](#6-gerenciar-salas)
7. [Ferramentas dos agentes](#7-ferramentas-dos-agentes)
8. [Storage e limpeza](#8-storage-e-limpeza)

---

## 1. Servidor

Roda como LaunchAgent do macOS, sem Docker: um `node` em `127.0.0.1:49375` e o
SQLite em `~/.ai-room/ai-room.sqlite`. Sobe no login e volta sozinho se cair.

| Comando | Faz |
|---|---|
| `ai-room status` | Servidor, banco e MCP respondendo? |
| `~/dev/ai-agent-config/scripts/ai-room-service.sh status` | Serviço instalado e rodando? |
| `~/dev/ai-agent-config/scripts/ai-room-service.sh start` | Sobe o servidor (em segundo plano) |
| `~/dev/ai-agent-config/scripts/ai-room-service.sh stop` | Derruba o servidor (volta no próximo login ou `start`) |
| `~/dev/ai-agent-config/scripts/ai-room-service.sh restart` | Reinicia o servidor |
| `~/dev/ai-agent-config/scripts/ai-room-service.sh logs` | Log ao vivo (`Ctrl+C` sai, o servidor continua) |
| `~/dev/ai-agent-config/scripts/ai-room-service.sh uninstall` | Remove o serviço (repo, banco e configs ficam) |

Depois de mudar o código do ai-room:

```bash
cd ~/dev/ai-room && pnpm build && ~/dev/ai-agent-config/scripts/ai-room-service.sh restart
```

---

## 2. Abrir uma sala

```bash
ai-room open <sala> --brief "..." --invite claude,codex,agy
```

| Comando | Faz |
|---|---|
| `ai-room open <sala> --brief "..." --invite ...` | Cria a sala, lança os agentes e entra no workspace |
| `ai-room open <sala>` | Reabre a sala com o mesmo charter e o mesmo elenco |

| Flag | Faz |
|---|---|
| `--tool rtk,graphify` | Ferramentas declaradas no briefing |
| `--convention caveman,ponytail` | Regras de escrita para todos os agentes |
| `--role codex=reviewer` | Papel de um agente |
| `--no-defaults` | Ignora os padrões de `~/.ai-room/config.json` |
| `--no-files` | Sem aba de arquivos |
| `--mouse` | Mouse no tmux (clique no tree) |
| `--reuse` | Reusa uma sala que já tem histórico de outra tarefa |
| `--detached` · `--dry-run` | Uma sessão por agente · só mostra o plano |

Padrões de sala nova, em `~/.ai-room/config.json`:

```json
{ "defaults": { "tools": ["rtk", "graphify"], "convention": "caveman,ponytail" } }
```

Flags passadas na hora ganham; sala que já existe mantém o próprio charter.
Também aceita `"invite": ["claude", "codex", "agy"]`.

---

## 3. Dentro do workspace

| Tecla | Faz |
|---|---|
| `F12` | Sai do workspace; agentes seguem vivos |
| `Ctrl-b d` · `Ctrl-b Ctrl-d` · `Ctrl-b q` | O mesmo detach |
| `Ctrl-b m` | Menu: mostra/esconde agentes, humano (monitor) e arquivos |
| `Ctrl-b t` | Mostra/esconde a aba de arquivos |
| `Ctrl-b setas` | Troca de pane |
| `Ctrl-b z` | Pane em tela cheia (repita para voltar) |
| `Ctrl-b X` | Fecha a sala (pede confirmação) |

Fechar a janela do terminal é só um detach: `ai-room open <sala>` volta.
Esconder um pane nunca para o agente.

---

## 4. Console `human>`

| Comando | Faz |
|---|---|
| texto + Enter | Manda mensagem para a sala |
| colar várias linhas | Vira uma mensagem só |
| `/show` · `/clear` | Mostra · descarta o rascunho |
| `/who` | Status dos agentes |
| `/attach <agente>` | Vai para o pane do agente |
| `/panes` · `/hide <x>` · `/show <x>` | Lista, esconde e mostra panes |
| `/agents` | Panes e sessões vivas |
| `/detach` | Sai do workspace |
| `/close sim` | Fecha a sala |
| `/help` · `/quit` | Ajuda · sai do console |

---

## 5. Anexos

Tudo que está no rascunho (texto + anexos) vai numa mensagem só no Enter.

| Comando | Faz |
|---|---|
| `Ctrl+V` ou `/paste` | Anexa o screenshot do clipboard |
| `/file <caminho>` | Anexa um arquivo (png, jpeg, gif, webp, pdf, texto) |
| arrastar arquivo | Também anexa |
| `/drop <n>` | Remove o anexo n do rascunho |

Limites: 10MB por arquivo, 5 por mensagem. Os agentes recebem só os metadados
e abrem o arquivo com `room_attachment` quando precisam.

---

## 6. Gerenciar salas

| Comando | Faz |
|---|---|
| `ai-room rooms [busca]` | Lista as salas |
| `ai-room who <sala>` | Participantes e status |
| `ai-room messages <sala>` | Histórico |
| `ai-room pane <sala> <pane> [show\|hide\|toggle]` | Mostra/esconde um pane pelo shell |
| `ai-room close <sala>` | Fecha os panes; histórico e charter ficam |
| `ai-room delete <sala>` | Apaga a sala de vez (pede o nome); `--yes` para scripts |

---

## 7. Ferramentas dos agentes

| Ferramenta | Faz sozinha? | Como usar |
|---|---|---|
| **rtk** | Sim (Claude e Codex) | Hook comprime a saída dos comandos shell. `rtk gain` mostra a economia |
| **ponytail** | Sim (Claude e Codex) | Código mínimo. `/ponytail lite\|full\|ultra\|off`, `/ponytail-review`, `/ponytail-audit`. No agy, só via `--convention ponytail` |
| **caveman** | Via convenção | `--convention caveman`: todos os agentes respondem curto |
| **graphify** | Não | O agente roda `graphify extract` e `graphify query "..."` quando a sala declara `--tool graphify` |
| **grill-me** | Não | `/grill-me` numa conversa nova, sem plan mode. Interroga o plano; não grava nada |
| **grill-with-docs** | Não | `/grill-with-docs` no repo. Mesma entrevista, grava `CONTEXT.md` e ADRs em `docs/adr/` |

`--tool` só declara a ferramenta no briefing; não instala nem executa.
`--convention` injeta a regra no briefing de todos, inclusive o agy.

Instalar, reparar e conferir:

```bash
~/dev/ai-agent-config/scripts/install-agent-tools.sh
~/dev/ai-agent-config/scripts/doctor.sh
```

---

## 8. Storage e limpeza

| Comando | Faz |
|---|---|
| `ai-room storage` | Tamanho do banco, anexos e logs; salas que mais ocupam |
| `ai-room storage --json` | O mesmo em JSON |
| `ai-room attachments prune --older-than 30d` | Apaga arquivos de anexos antigos (o histórico fica) |
| `ai-room delete <sala>` | Apaga uma sala inteira |
| `ai-room compact` | Encolhe o banco depois de `delete`/`prune` |

Ordem para liberar espaço: `storage` → `delete` / `prune` → `compact`.
