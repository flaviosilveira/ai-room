#!/bin/sh
# Fast path for the ai-room unread hook.
#
# This runs on every tool call of every session of the harness, including the
# many that have nothing to do with ai-room. Starting Python just to discover
# that costs ~60ms each time, so the one question that can be answered without
# an interpreter is answered here: did the launcher put this session in a room?
#
# It decides that and nothing else. All hook behaviour — the endpoint, the
# fast path for zero unread, fail-open, logging — stays in the Python hook.
[ -n "${AI_ROOM_ROOM}" ] && [ -n "${AI_ROOM_AGENT}" ] || exit 0

dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P) || exit 0
# exec keeps stdin, so the hook payload reaches Python untouched.
exec "${AI_ROOM_PYTHON:-python3}" "$dir/ai-room-unread-hook.py" "$@"
