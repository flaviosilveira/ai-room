#!/usr/bin/env python3
"""
Claude Code `Stop` hook for ai-room.

Keeps an agent in its listen loop without relying on the model choosing to stay.
When the session is still an active participant in a room, the hook blocks the
stop and tells the model to call room_wait again. Leaving the room (room_leave)
or an unreachable server both release the block.

Fails OPEN: any error, timeout, or ambiguity allows the stop. A listen loop is
never worth wedging a session over.
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

PORT = os.environ.get("AI_ROOM_PORT", "49375")
BASE_URL = f"http://127.0.0.1:{PORT}"
STATE_DIR = os.path.expanduser("~/.ai-room")
# Backstop against a wedged session. Raise via AI_ROOM_MAX_STOP_BLOCKS.
MAX_BLOCKS = int(os.environ.get("AI_ROOM_MAX_STOP_BLOCKS", "500"))
ROOM_TOOLS = ("room_join", "room_wait", "room_listen", "room_send", "room_set_status")


def allow():
    sys.exit(0)


def block(reason):
    json.dump({"decision": "block", "reason": reason}, sys.stdout)
    sys.exit(0)


def last_room_call(transcript_path):
    """Most recent ai-room tool call in the transcript -> (room, agent, left)."""
    if not transcript_path or not os.path.exists(transcript_path):
        return None
    try:
        with open(transcript_path, "r", encoding="utf-8", errors="replace") as handle:
            lines = handle.readlines()
    except OSError:
        return None

    for line in reversed(lines):
        line = line.strip()
        if not line or "room_" not in line:
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue

        content = (entry.get("message") or {}).get("content")
        if not isinstance(content, list):
            continue

        for block_item in reversed(content):
            if not isinstance(block_item, dict) or block_item.get("type") != "tool_use":
                continue
            name = block_item.get("name") or ""
            bare = name.rsplit("__", 1)[-1]
            params = block_item.get("input") or {}
            room, agent = params.get("room"), params.get("agent")
            if not room or not agent:
                continue
            if bare == "room_leave":
                return (room, agent, True)
            if bare in ROOM_TOOLS:
                return (room, agent, False)
    return None


def is_active(room, agent):
    query = urllib.parse.urlencode({"agent": agent, "room": room})
    try:
        with urllib.request.urlopen(f"{BASE_URL}/active?{query}", timeout=3) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError, json.JSONDecodeError):
        return None  # server down -> fail open
    if not payload.get("ok"):
        return None
    return bool(payload.get("active")), int(payload.get("unread") or 0)


def block_count(session_id, reset=False):
    """Consecutive blocks for this session, so a wedge cannot run forever."""
    if not session_id:
        return 0
    path = os.path.join(STATE_DIR, f"stopblocks-{session_id}.txt")
    if reset:
        try:
            os.remove(path)
        except OSError:
            pass
        return 0
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        current = 0
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as handle:
                current = int((handle.read() or "0").strip() or 0)
        current += 1
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(str(current))
        return current
    except (OSError, ValueError):
        return 0


def main():
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        allow()

    session_id = payload.get("session_id") or ""
    found = last_room_call(payload.get("transcript_path"))
    if not found:
        block_count(session_id, reset=True)
        allow()

    room, agent, left = found
    if left:
        block_count(session_id, reset=True)
        allow()

    state = is_active(room, agent)
    if state is None:
        block_count(session_id, reset=True)
        allow()

    active, unread = state
    if not active:
        block_count(session_id, reset=True)
        allow()

    count = block_count(session_id)
    if count > MAX_BLOCKS:
        block_count(session_id, reset=True)
        allow()

    if unread > 0:
        block(
            f"You are still in ai-room '{room}' as '{agent}' and {unread} message(s) "
            f"are unread. Call room_wait(room='{room}', agent='{agent}') now and handle them."
        )
    block(
        f"You are still an active participant in ai-room '{room}' as '{agent}'. "
        f"Do not stop. Call room_wait(room='{room}', agent='{agent}') now. "
        f"It blocks server-side for minutes at no token cost. "
        f"When it returns status 'timeout', call it again and emit no text. "
        f"Leave the loop only via room_leave or a direct human instruction."
    )


if __name__ == "__main__":
    main()
