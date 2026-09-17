#!/usr/bin/env python3
"""
PreToolUse hook for ai-room, for Claude Code and Codex (same wire contract).

An agent that is working has no room_wait parked, so nothing wakes it: a message
sits unread until the agent happens to ask again. This hook closes that gap at
the only safe place — the boundary before the next tool call — by telling the
agent that messages are pending. It never delivers them.

Deliberately advisory. It reads one local, read-only endpoint and prints a short
line of context. It does not read message content, does not advance the read
cursor, does not send anything to the room, and does not approve, deny or alter
any permission decision: consuming still happens through room_wait/room_listen,
called by the agent itself.

Fails OPEN on everything — server down, timeout, bad JSON, unknown identity. A
notification is never worth blocking an agent's work over.
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

PORT = os.environ.get("AI_ROOM_PORT", "49375")
BASE_URL = f"http://127.0.0.1:{PORT}"
TIMEOUT_S = float(os.environ.get("AI_ROOM_HOOK_TIMEOUT", "0.7"))
LOG_PATH = os.path.expanduser(
    os.environ.get("AI_ROOM_HOOK_LOG", "~/.ai-room/logs/unread-hook.jsonl")
)
LOG_MAX_BYTES = int(os.environ.get("AI_ROOM_HOOK_LOG_MAX", str(512 * 1024)))
ROOM_TOOL = re.compile(r"(^|_)room_(join|wait|listen|send|leave|who|history|charter|set_status|set_charter)$")


def quiet_exit():
    """Fail open: no output at all is a valid, silent hook result."""
    sys.exit(0)


def identity():
    """
    (room, agent) for this session, from the launcher and nowhere else.

    `ai-room open` exports both into the agent's process, so identity is what
    ai-room assigned. Guessing it from transcript text would let an unrelated
    session — a developer working on this very repo — be told about a room it
    never joined, and could point one room's agent at another room's unread.
    No variables, no notice.
    """
    return os.environ.get("AI_ROOM_ROOM"), os.environ.get("AI_ROOM_AGENT")


def unread_count(room, agent):
    query = urllib.parse.urlencode({"agent": agent, "room": room})
    with urllib.request.urlopen(f"{BASE_URL}/active?{query}", timeout=TIMEOUT_S) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not payload.get("ok"):
        return 0
    # Scoped by room server-side; anything else is not this agent's business.
    rooms = [entry for entry in payload.get("rooms") or [] if entry.get("room") == room]
    return sum(int(entry.get("unread") or 0) for entry in rooms)


def record(room, agent, unread, boundary):
    """
    Diagnostic breadcrumb: enough to prove later that the hook saw the gap and
    when. Never the messages themselves.
    """
    try:
        os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
        if os.path.exists(LOG_PATH) and os.path.getsize(LOG_PATH) > LOG_MAX_BYTES:
            os.replace(LOG_PATH, LOG_PATH + ".1")
        with open(LOG_PATH, "a", encoding="utf-8") as handle:
            handle.write(
                json.dumps(
                    {
                        "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                        "room": room,
                        "agent": agent,
                        "unread": unread,
                        "boundary": boundary,
                    }
                )
                + "\n"
            )
    except OSError:
        pass


def main():
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        quiet_exit()
    if not isinstance(payload, dict):
        quiet_exit()

    boundary = payload.get("hook_event_name") or "PreToolUse"
    tool = (payload.get("tool_name") or "").rsplit("__", 1)[-1]
    # The agent is already talking to the room; nagging here would interrupt the
    # very call that consumes the messages.
    if ROOM_TOOL.search(tool):
        quiet_exit()

    room, agent = identity()
    if not room or not agent:
        quiet_exit()

    try:
        unread = unread_count(room, agent)
    except (urllib.error.URLError, OSError, ValueError, json.JSONDecodeError, TypeError):
        quiet_exit()

    if unread <= 0:
        quiet_exit()

    record(room, agent, unread, boundary)
    json.dump(
        {
            "hookSpecificOutput": {
                "hookEventName": boundary,
                "additionalContext": (
                    f"ai-room: {unread} unread message(s) in room '{room}' for agent '{agent}'. "
                    f"Read them with room_wait(room='{room}', agent='{agent}') before continuing "
                    f"work that depends on the room's context."
                ),
            }
        },
        sys.stdout,
    )
    sys.exit(0)


if __name__ == "__main__":
    main()
