#!/bin/sh
# Fast path for the ai-room gate on Claude Code and Codex: out of a room there
# is no one to ask, so the harness's own checks stay in charge and Python is
# never started. agy calls ai-room-gate.py directly, since it needs an answer
# either way.
[ -n "${AI_ROOM_ROOM}" ] && [ -n "${AI_ROOM_AGENT}" ] || exit 0

dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P) || exit 0
exec "${AI_ROOM_PYTHON:-python3}" "$dir/ai-room-gate.py" "$@"
