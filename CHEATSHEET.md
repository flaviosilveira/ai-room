# ai-room cheatsheet

## Salas

```bash
ai-room open <sala> --brief "..." --invite claude,codex,agy
```

| Comando | Faz |
|---|---|
| `ai-room open <sala> --brief "..." --invite ...` | Cria a sala, lança os agentes e entra no workspace |
| `ai-room open <sala>` | Reabre a sala com o mesmo charter e o mesmo elenco |
| `ai-room close <sala>` | Fecha os panes; histórico e charter ficam |
| `ai-room delete <sala>` | Apaga a sala de vez (pede o nome); `--yes` para scripts |
| `ai-room rooms [busca]` | Lista as salas |
| `ai-room who <sala>` · `ai-room messages <sala>` | Participantes · histórico |
| `ai-room pane <sala> <pane> [show\|hide\|toggle]` | Mostra/esconde um pane pelo shell |
| `ai-room attachments prune --older-than 30d` | Apaga arquivos de anexos antigos |
| `ai-room status` | Saúde do servidor |

Flags do `open`:

| Flag | Faz |
|---|---|
| `--tool rtk,graphify` | Ferramentas declaradas no briefing |
| `--convention caveman,ponytail` | Regras de escrita para todos os agentes |
| `--role codex=reviewer` | Papel de um agente |
| `--no-defaults` | Ignora os padrões de `~/.ai-room/config.json` |
| `--no-files` | Sem aba de arquivos |
| `--mouse` | Mouse no tmux (clique no tree) |
| `--detached` · `--dry-run` | Uma sessão por agente · só mostra o plano |

Padrões de sala nova ficam em `~/.ai-room/config.json`:

```json
{ "defaults": { "tools": ["rtk", "graphify"], "convention": "caveman,ponytail" } }
```

Flags passadas na hora ganham; sala que já existe mantém o próprio charter.
Também aceita `"invite": ["claude", "codex", "agy"]`.

## Teclas no workspace

| Tecla | Faz |
|---|---|
| `F12` | Sai do workspace; agentes seguem vivos |
| `Ctrl-b d` · `Ctrl-b Ctrl-d` · `Ctrl-b q` | O mesmo detach |
| `Ctrl-b m` | Menu: mostra/esconde agentes, humano (monitor) e arquivos |
| `Ctrl-b t` | Mostra/esconde a aba de arquivos |
| `Ctrl-b X` | Fecha a sala (pede confirmação) |
| `Ctrl-b setas` | Troca de pane |
| `Ctrl-b z` | Pane em tela cheia (repita para voltar) |

Fechar a janela do terminal é só um detach: `ai-room open <sala>` volta.

## Console (`human>`)

| Comando | Faz |
|---|---|
| texto + Enter | Manda mensagem para a sala |
| colar várias linhas | Vira uma mensagem só |
| `Ctrl+V` ou `/paste` | Anexa o screenshot do clipboard |
| `/file <caminho>` | Anexa um arquivo (imagem, pdf, texto) |
| arrastar arquivo | Também anexa |
| `/drop <n>` | Remove um anexo do rascunho |
| `/show` · `/clear` | Mostra · descarta o rascunho |
| `/who` | Status dos agentes |
| `/attach <agente>` | Vai para o pane do agente |
| `/panes` · `/hide <x>` · `/show <x>` | Lista, esconde e mostra panes |
| `/agents` | Panes e sessões vivas |
| `/detach` | Sai do workspace |
| `/close sim` | Fecha a sala |
| `/help` · `/quit` | Ajuda · sai do console |

## Ferramentas

| Ferramenta | Faz sozinha? | Como usar |
|---|---|---|
| **rtk** | Sim (Claude e Codex) | Hook comprime a saída dos comandos shell. `rtk gain` mostra a economia |
| **ponytail** | Sim (Claude e Codex) | Código mínimo. `/ponytail lite\|full\|ultra\|off`, `/ponytail-review`, `/ponytail-audit`. No agy, só via `--convention ponytail` |
| **grill-me** | Não | `/grill-me` numa conversa nova, sem plan mode. Interroga o plano; não grava nada |
| **grill-with-docs** | Não | `/grill-with-docs` no repo. Mesma entrevista, grava `CONTEXT.md` e ADRs em `docs/adr/` |
| **graphify** | Não | O agente roda `graphify extract` e `graphify query "..."` quando a sala declara `--tool graphify` |
| **caveman** | Via convenção | `--convention caveman`: todos os agentes respondem curto |

`--tool` só declara a ferramenta no briefing; não instala nem executa.
`--convention` injeta a regra no briefing de todos, inclusive o agy.

Instalar ou reparar as ferramentas:

```bash
~/dev/ai-agent-config/scripts/install-agent-tools.sh
~/dev/ai-agent-config/scripts/doctor.sh
```
