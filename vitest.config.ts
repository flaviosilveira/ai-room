import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Real-tmux tests get a server of their own, never the workspace one.
    env: {
      AI_ROOM_TMUX_SOCKET: `ai-room-vitest-${process.pid}`,
      AI_ROOM_TMUX_CONF: path.join(os.tmpdir(), `ai-room-vitest-${process.pid}.conf`),
    },
  },
});
