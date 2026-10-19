#!/usr/bin/env python3
"""
PreToolUse gate for ai-room agents: one place where the human approves what
an agent was stopped from doing, instead of a prompt in each agent's pane.

    ai-room-gate.py --harness claude|codex|agy   (event JSON on stdin)

In a room (the launcher sets AI_ROOM_ROOM and AI_ROOM_AGENT):

  touches ai-room's own state or a harness's settings  -> deny
  on the deny list                                     -> deny
  on the ask list                                      -> blocked and filed for the
                                                          human; allowed once after /allow
  anything else, Claude and Codex                      -> no answer: their own auto
                                                          mode / reviewer decides
  anything else, with AI_ROOM_SKIP_PROMPTS=1          -> the harness runs with its own
                                                          prompts skipped, so this is its
                                                          only check: everything is free
                                                          but edits outside the workspace,
                                                          which go to the lead

Out of a room there is nobody to ask: Claude and Codex are left alone (the
shell wrapper does not even start Python), agy gets its own prompt back.

Same user, same machine: this guards against mistakes and a misled agent, not
against a process that sets out to defeat it.
"""
import json, os, re, shlex, sys, time, urllib.request

PORT = os.environ.get("AI_ROOM_PORT", "49375")
BASE_URL = f"http://127.0.0.1:{PORT}"
POLICY_PATH = os.path.expanduser(os.environ.get("AI_ROOM_POLICY", "~/.ai-room/policy.json"))
LOG_PATH = os.path.expanduser("~/.ai-room/logs/gate.log")
HOME = os.path.expanduser("~")
HERE = os.path.dirname(os.path.abspath(__file__))

# Used when ~/.ai-room/policy.json does not exist.
DEFAULT_POLICY = {
    "allow": [],
    "ask": [
        "git push --force", "git push -f", "git push * --force", "git push * -f",
        "git reset --hard", "git clean", "rm -rf", "sudo",
        "terraform apply", "terraform destroy", "kubectl apply", "kubectl delete",
        "aws * delete-*", "aws * terminate-*", "aws s3 rm", "gh pr merge", "db-rw",
    ],
    "deny": ["rm -rf /", "rm -rf ~", "rm -rf ~/"],
}

PROTECTED = [
    os.path.join(HOME, ".ai-room"), "~/.ai-room", HERE,
    os.path.join(HOME, ".claude", "settings"), os.path.join(HOME, ".claude.json"),
    os.path.join(HOME, ".codex", "config.toml"), os.path.join(HOME, ".codex", "hooks.json"),
    os.path.join(HOME, ".gemini", "config"), os.path.join(HOME, ".gemini", "antigravity-cli", "settings.json"),
    "ai-room.sqlite",
    # The console's door: a message posted there is the human's, and reaches panes as such.
    "49375/say",
]

SEPARATORS = {";", "&&", "||", "|", "&", "\n"}
HARMLESS = re.compile(r"[0-9&]?>>?\s*/dev/null|[0-9]?>&[0-9]")
HIDDEN = re.compile(r"\$\(|`|[<>]")
READ_TOOL = re.compile(r"^(view_|list_|grep_|find_|codebase_|search_|read_resource|read_terminal)")
EDIT_TOOL = re.compile(r"(write|replace|edit|create|delete|move|rename|patch)", re.I)
ROOM_TOOL = re.compile(r"(^mcp:ai-room/|(^|_)room_[a-z_]+$)")
SCRATCH = [os.path.join(HOME, ".gemini", "antigravity-cli", "brain"), "/tmp", "/private/tmp"]

# What only the human answers, beyond the ask list: changes nobody can take
# back. Reads stay free, here and on other machines.
CRITICAL = [
    (re.compile(r"^(rtk\s+)?git\s+push\b.*(\s--force\b|\s-f\b|\b(main|master)\b)"), "a force push or a push to main/master"),
    (re.compile(r"^(rtk\s+)?az\s+.*\b(create|delete|update|set|start|stop|restart|deploy|scale|purge|import|assign|remove|add|reset|swap)\b"),
     "it changes something in Azure"),
]
SSH_OPTIONS_WITH_VALUE = set("bcDEeFIiJLlmOoPpQRSWw")
REMOTE_DELETE = re.compile(r"^(sudo\s+)?rm\s+-\w*[rRf]")
SYSTEM_PATHS = ["/etc", "/usr", "/System", "/Library", "/bin", "/sbin", "/opt",
                *(os.path.join(HOME, name) for name in (".ssh", ".aws", ".zshrc", ".bashrc", ".profile", ".gitconfig"))]

def load_policy():
    try:
        policy = json.load(open(POLICY_PATH))
    except (OSError, ValueError):
        policy = DEFAULT_POLICY
    return {key: [re_prefix(p) for p in policy.get(key, [])] for key in ("allow", "ask", "deny")}


def re_prefix(prefix):
    body = r"\s+".join(".*" if t == "*" else re.escape(t).replace(r"\*", r"\S*") for t in prefix.split())
    return re.compile(rf"^(rtk\s+)?{body}(\s|$)")


def parts(command):
    lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|")
    lexer.whitespace_split = True
    current, result = [], []
    for token in lexer:
        if token in SEPARATORS:
            result.append(current)
            current = []
        else:
            current.append(token)
    result.append(current)
    return [" ".join(p) for p in result if p]


def classify(command, policy):
    """deny, ask, allow, or None when the lists do not settle it."""
    command = HARMLESS.sub(" ", command)
    try:
        segments = parts(command)
    except ValueError:
        return None
    hit = lambda key, seg: any(rule.match(seg) for rule in policy[key])
    if any(hit("deny", s) for s in segments):
        return "deny"
    if any(hit("ask", s) for s in segments):
        return "ask"
    if segments and not HIDDEN.search(command) and all(hit("allow", s) for s in segments):
        return "allow"
    return None


def remote_command(segment):
    """What `ssh [options] host <command>` runs on the other machine, if anything."""
    tokens = segment.split()
    if not tokens or tokens[0] != "ssh":
        return None
    i = 1
    while i < len(tokens) and tokens[i].startswith("-"):
        option = tokens[i]
        i += 2 if len(option) == 2 and option[1] in SSH_OPTIONS_WITH_VALUE else 1
    return " ".join(tokens[i + 1:]) or None


def critical(command, policy):
    try:
        segments = parts(HARMLESS.sub(" ", command))
    except ValueError:
        segments = [command]
    for segment in segments:
        for pattern, reason in CRITICAL:
            if pattern.search(segment):
                return reason
        remote = remote_command(segment)
        if remote and (REMOTE_DELETE.search(remote) or classify(remote, policy) in ("ask", "deny") or critical(remote, policy)):
            return "a risky command on another machine"
    return None


def protected(text):
    expanded = text.replace("~/", HOME + "/")
    return any(path in expanded for path in PROTECTED)


def paths_in(args):
    found = []
    for value in args.values() if isinstance(args, dict) else []:
        if isinstance(value, str) and (value.startswith("/") or value.startswith("~")):
            found.append(os.path.realpath(os.path.expanduser(value)))
    return found


def inside(path, roots):
    return any(path == root or path.startswith(root.rstrip("/") + "/") for root in roots)


def ask_human(room, agent, action, reason, tier):
    """Files the request; True only if this exact action was already allowed by someone the tier allows."""
    body = json.dumps({"room": room, "agent": agent, "action": action, "reason": reason, "tier": tier}).encode()
    request = urllib.request.Request(f"{BASE_URL}/gate/request", data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=3) as response:
        answer = json.loads(response.read().decode())
    if answer.get("status") == "allowed":
        return True, answer.get("id")
    return False, answer


def blocked_message(answer, reason, tier):
    if answer.get("status") == "denied":
        return f"This was denied (request #{answer.get('id')}). Do not retry it; find another way or ask in the room."
    who = "the human" if tier == "human" else "the lead or the human"
    return (f"Blocked until {who} allows it (request #{answer.get('id')}): {reason}. "
            "Keep working on whatever does not need it; when you are told it is approved, run exactly the same thing again.")


def event(harness, payload):
    """(tool, args, command, cwd, workspaces) for either wire format."""
    if harness == "agy":
        call = payload.get("toolCall") or {}
        args = call.get("args") or {}
        # agy wraps every MCP call in one tool; the server and tool it names are what matter.
        if call.get("name") == "call_mcp_tool":
            return f"mcp:{args.get('ServerName')}/{args.get('ToolName')}", args.get("Arguments") or {}, None, None, payload.get("workspacePaths") or []
        command = args.get("CommandLine") if call.get("name") == "run_command" else None
        return call.get("name") or "", args, command, args.get("Cwd"), payload.get("workspacePaths") or []
    args = payload.get("tool_input") or {}
    command = args.get("command")
    if isinstance(command, list):
        command = shlex.join(command)
    return payload.get("tool_name") or "", args, command, payload.get("cwd"), []


def decide(harness, payload, room, agent):
    """(decision, reason): decision is allow, deny, ask (agy's own prompt) or None (no answer)."""
    tool, args, command, cwd, workspaces = event(harness, payload)
    policy = load_policy()
    subject = command if command is not None else f"{tool} {json.dumps(args, sort_keys=True)}"

    # Reads stay free: agents open the room's attachments under ~/.ai-room.
    if (command is not None or EDIT_TOOL.search(tool)) and protected(subject):
        return "deny", "it changes ai-room's own state or an agent's settings"
    verdict = classify(command, policy) if command is not None else None
    if verdict == "deny":
        return "deny", "on the deny list"
    if not room:
        return ("ask", "no room to ask in") if harness == "agy" else (None, "")

    # A harness launched with its prompts skipped (agy, and Claude in a room)
    # has this gate as its only check, so it decides everything; otherwise the
    # harness's own prompt still comes after, and only the lists need an answer.
    skipping = os.environ.get("AI_ROOM_SKIP_PROMPTS") == "1"
    reason, tier = None, "lead"
    serious = critical(command, policy) if command is not None else None
    if verdict == "ask":
        reason, tier = "on the ask list", "human"
    elif serious:
        reason, tier = serious, "human"
    elif not skipping:
        return ("ask", "agy's own prompt") if harness == "agy" else (None, "")
    elif command is None and EDIT_TOOL.search(tool):
        roots = [os.path.realpath(p) for p in [*workspaces, cwd or os.getcwd(), *SCRATCH] if p]
        targets = paths_in(args)
        if not targets or all(inside(path, roots) for path in targets):
            return "allow", "an edit inside the workspace"
        reason = "an edit outside the workspace"
        if any(inside(path, [os.path.realpath(p) for p in SYSTEM_PATHS]) for path in targets):
            reason, tier = "an edit to system or account settings", "human"
    else:
        return "allow", "free: not on the lists"

    allowed, answer = ask_human(room, agent, subject[:500], reason, tier)
    if allowed:
        return "allow", f"allowed (request #{answer})"
    return "deny", blocked_message(answer, reason, tier)


def answer(harness, decision, reason):
    if harness == "agy":
        print(json.dumps({"decision": decision or "ask", "reason": reason}))
    elif decision in ("allow", "deny"):
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse", "permissionDecision": decision, "permissionDecisionReason": reason}}))


def log(line):
    try:
        os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
        with open(LOG_PATH, "a") as handle:
            handle.write(f"{time.strftime('%F %T')} {line}\n")
    except OSError:
        pass


def main():
    harness = sys.argv[sys.argv.index("--harness") + 1] if "--harness" in sys.argv else "claude"
    room, agent = os.environ.get("AI_ROOM_ROOM"), os.environ.get("AI_ROOM_AGENT")
    payload = {}
    try:
        payload = json.load(sys.stdin)
        decision, reason = decide(harness, payload, room, agent)
    except Exception as error:
        # agy skips its own prompts in a room, so there a failure must block.
        # Elsewhere, no answer leaves the harness's own checks in charge.
        decision = "deny" if harness == "agy" and room and os.environ.get("AI_ROOM_SKIP_PROMPTS") == "1" else None
        reason = f"the ai-room gate failed: {error}"
    subject = ""
    try:
        tool, args, command, _, _ = event(harness, payload)
        subject = (command if command is not None else f"{tool} {json.dumps(args)}")[:160]
    except Exception:
        pass
    # Passing a call on to the harness's own checks is the common case and says nothing.
    if decision is not None:
        log(f"{harness} {room or '-'} {agent or '-'} {decision}: {reason} | {subject}")
    answer(harness, decision, reason)


if __name__ == "__main__":
    main()
