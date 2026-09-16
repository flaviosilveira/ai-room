export const MIN_NODE_API = 10;

export function unsupportedRuntimeMessage(
  napi: string | undefined,
  version: string = process.version,
  execPath: string = process.execPath
): string | null {
  const current = Number.parseInt(napi ?? "", 10);
  if (Number.isFinite(current) && current >= MIN_NODE_API) return null;

  return [
    "ai-room: unsupported Node runtime.",
    "",
    `  node       ${version}`,
    `  path       ${execPath}`,
    `  Node-API   ${Number.isFinite(current) ? current : "unknown"} (need ${MIN_NODE_API})`,
    "",
    "The bundled SQLite binding is a Node-API " + MIN_NODE_API + " addon. Loading it on this",
    "runtime kills the process with SIGSEGV instead of failing cleanly.",
    "",
    "Run ai-room on Node 23 or newer. If a version manager picks the Node",
    "version from the working directory, point AI_ROOM_NODE at a supported",
    "node and launch through it.",
    "",
  ].join("\n");
}

export function assertSupportedRuntime(): void {
  const message = unsupportedRuntimeMessage(process.versions.napi);
  if (!message) return;
  process.stderr.write(message + "\n");
  process.exit(1);
}
