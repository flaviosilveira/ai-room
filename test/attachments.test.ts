import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openDb } from "../src/db/index.js";
import { createHttpApp } from "../src/http.js";
import { blobPath, imageSize, readStoredFile, sniffType } from "../src/attachments.js";
import { pastedFilePath, readAttachableFile, readClipboard } from "../src/clipboard.js";
import { Composer } from "../src/console.js";
import { createPasteStream, PASTE_END, PASTE_START } from "../src/paste.js";
import {
  collectOrphanAttachments,
  createAttachment,
  getAttachment,
  pruneAttachments,
  roomHistory,
  roomJoin,
  compactDatabase,
  roomDelete,
  roomExists,
  storageCounts,
  roomListen,
  roomSend,
  roomWho,
} from "../src/store.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

let root: string;
const previousRoot = process.env.AI_ROOM_ATTACHMENT_DIR;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "airoom-att-"));
  process.env.AI_ROOM_ATTACHMENT_DIR = root;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (previousRoot === undefined) delete process.env.AI_ROOM_ATTACHMENT_DIR;
  else process.env.AI_ROOM_ATTACHMENT_DIR = previousRoot;
});

describe("attachment types", () => {
  it("trusts the bytes, not the name", () => {
    expect(sniffType(PNG_1X1, "x.txt")).toMatchObject({ mime: "image/png", ext: "png" });
    expect(sniffType(Buffer.from("%PDF-1.7\n"), "a.png")).toMatchObject({ mime: "application/pdf" });
    expect(sniffType(Buffer.from("echo hi\n"), "screenshot.png")).toMatchObject({ kind: "text", ext: "txt" });
    expect(sniffType(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]), "a.png")).toBeNull();
  });

  it("refuses SVG as an image", () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect(sniffType(svg, "logo.svg")).toMatchObject({ kind: "text", ext: "txt", mime: "text/plain" });
  });

  it("reads image dimensions from the header", () => {
    expect(imageSize(PNG_1X1, "image/png")).toEqual({ width: 1, height: 1 });
  });

  it("never lets an identity become a path outside the store", () => {
    expect(() => blobPath("../../etc/passwd", "png")).toThrow();
    expect(() => blobPath("a".repeat(64), "p/ng")).toThrow();
  });
});

describe("attachments in the store", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(":memory:");
    roomJoin(db, { room: "r", agent: "human" });
    roomJoin(db, { room: "r", agent: "codex" });
    roomJoin(db, { room: "other", agent: "human" });
  });
  afterEach(() => db.close());

  it("keeps one paste with an image as one message", () => {
    const image = createAttachment(db, { room: "r", bytes: PNG_1X1, name: "shot.png" });
    const sent = roomSend(db, { room: "r", agent: "human", origin: "human", message: "olha esse erro", attachmentIds: [image.id] });
    expect(sent.attachments?.map((a) => a.id)).toEqual([image.id]);

    const unread = roomListen(db, { room: "r", agent: "codex" });
    expect(unread).toHaveLength(1);
    expect(unread[0].content).toBe("olha esse erro");
    expect(unread[0].attachments?.[0]).toMatchObject({ name: "shot.png", mime: "image/png", width: 1, height: 1 });
    // Metadata only: no bytes travel with the message.
    expect(JSON.stringify(unread)).not.toContain(PNG_1X1.toString("base64"));
  });

  it("leaves messages without attachments exactly as before", () => {
    roomSend(db, { room: "r", agent: "human", message: "oi" });
    expect(Object.keys(roomHistory(db, { room: "r" })[0])).not.toContain("attachments");
  });

  it("stores the same content once", () => {
    const a = createAttachment(db, { room: "r", bytes: PNG_1X1, name: "a.png" });
    const b = createAttachment(db, { room: "r", bytes: PNG_1X1, name: "b.png" });
    expect(a.id).not.toBe(b.id);
    expect(a.path).toBe(b.path);
    expect(fs.statSync(a.path!).mode & 0o777).toBe(0o600);
  });

  it("scopes attachment ids to their room", () => {
    const image = createAttachment(db, { room: "r", bytes: PNG_1X1 });
    expect(getAttachment(db, "other", image.id)).toBeNull();
    expect(() =>
      roomSend(db, { room: "other", agent: "human", message: "x", attachmentIds: [image.id] })
    ).toThrow(/does not exist/);
    // Nothing half-written: the failed send left no message behind.
    expect(roomHistory(db, { room: "other" })).toEqual([]);
  });

  it("collects uploads that were never sent", () => {
    const sent = createAttachment(db, { room: "r", bytes: PNG_1X1, name: "kept.png" });
    roomSend(db, { room: "r", agent: "human", message: "x", attachmentIds: [sent.id] });
    const orphan = createAttachment(db, { room: "r", bytes: Buffer.from("rascunho"), name: "n.txt" });
    expect(collectOrphanAttachments(db, -1)).toBe(1);
    expect(getAttachment(db, "r", orphan.id)).toBeNull();
    expect(fs.existsSync(orphan.path!)).toBe(false);
    expect(fs.existsSync(sent.path!)).toBe(true);
  });

  it("prunes the file and keeps the metadata", () => {
    const image = createAttachment(db, { room: "r", bytes: PNG_1X1 });
    roomSend(db, { room: "r", agent: "human", message: "x", attachmentIds: [image.id] });
    expect(pruneAttachments(db, { olderThanMs: -1 })).toBe(1);
    expect(fs.existsSync(image.path!)).toBe(false);
    expect(roomHistory(db, { room: "r" })[0].attachments?.[0]).toMatchObject({ id: image.id, path: null });
  });

  it("deletes a room and all it owns, and only that room", () => {
    const own = createAttachment(db, { room: "r", bytes: Buffer.from("so desta sala"), name: "a.txt" });
    const shared = createAttachment(db, { room: "r", bytes: PNG_1X1 });
    const elsewhere = createAttachment(db, { room: "other", bytes: PNG_1X1 });
    roomSend(db, { room: "r", agent: "human", message: "x", attachmentIds: [own.id, shared.id] });
    roomSend(db, { room: "other", agent: "human", message: "y", attachmentIds: [elsewhere.id] });

    expect(roomDelete(db, "r")).toEqual({ messages: 1, attachments: 2 });
    expect(roomExists(db, "r")).toBe(false);
    expect(roomWho(db, { room: "other" }).length).toBeGreaterThan(0);
    expect(fs.existsSync(own.path!)).toBe(false);
    // Same bytes still used by another room: the file stays.
    expect(fs.existsSync(shared.path!)).toBe(true);
    expect(roomHistory(db, { room: "other" })[0].attachments).toHaveLength(1);
    expect(roomDelete(db, "r")).toBeNull();
  });

  it("counts what the store holds, a shared file once", () => {
    const a = createAttachment(db, { room: "r", bytes: PNG_1X1 });
    const b = createAttachment(db, { room: "other", bytes: PNG_1X1 });
    roomSend(db, { room: "r", agent: "human", message: "x", attachmentIds: [a.id] });
    roomSend(db, { room: "other", agent: "human", message: "y", attachmentIds: [b.id] });
    const counts = storageCounts(db);
    expect(counts).toMatchObject({ rooms: 2, messages: 2, attachments: 2, attachmentBytes: PNG_1X1.length });
    expect(counts.largestRooms[0]).toMatchObject({ messages: 1, attachments: 1 });
    expect(() => compactDatabase(db)).not.toThrow();
  });

  it("refuses a symlink planted in the store", () => {
    const image = createAttachment(db, { room: "r", bytes: PNG_1X1 });
    fs.rmSync(image.path!);
    fs.symlinkSync("/etc/hosts", image.path!);
    expect(() => readStoredFile(image.path!)).toThrow(/regular file/);
  });

  it("keeps a store inside a git repo out of commits", () => {
    fs.mkdirSync(path.join(root, ".git"));
    const nested = path.join(root, "attachments");
    process.env.AI_ROOM_ATTACHMENT_DIR = nested;
    createAttachment(db, { room: "r", bytes: PNG_1X1 });
    expect(fs.readFileSync(path.join(nested, ".gitignore"), "utf8")).toBe("*\n");
  });
});

describe("attachments over HTTP and MCP", () => {
  let db: Database.Database;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    db = openDb(":memory:");
    server = await new Promise<Server>((resolve) => {
      const s = createHttpApp(db).listen(0, "127.0.0.1", () => resolve(s));
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    base = `http://127.0.0.1:${address.port}`;
    roomJoin(db, { room: "r", agent: "human" });
    roomJoin(db, { room: "r", agent: "claude", harness: "claude" });
    roomJoin(db, { room: "r", agent: "agy", harness: "agy" });
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });

  const upload = async (bytes: Buffer, name: string) => {
    const response = await fetch(`${base}/attachments?room=r&name=${name}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array(bytes),
    });
    return { status: response.status, body: (await response.json()) as { attachment?: { id: string }; error?: string } };
  };

  it("uploads, then sends text and image as one message", async () => {
    const { body } = await upload(PNG_1X1, "shot.png");
    const say = await fetch(`${base}/say`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room: "r", message: "olha", attachmentIds: [body.attachment!.id] }),
    });
    expect(say.status).toBe(200);
    const history = roomHistory(db, { room: "r" });
    expect(history).toHaveLength(1);
    expect(history[0].attachments).toHaveLength(1);
  });

  it("replays only what a reconnecting feed missed", async () => {
    const ids = ["um", "dois", "tres"].map((message) => roomSend(db, { room: "r", agent: "claude", message }).id);
    const controller = new AbortController();
    const response = await fetch(`${base}/stream?room=r&after=${ids[0]}`, { signal: controller.signal });
    const reader = response.body!.getReader();
    let text = "";
    while ((text.match(/event: message/g) ?? []).length < 2) text += new TextDecoder().decode((await reader.read()).value);
    controller.abort();
    expect(text).not.toContain('"um"');
    expect(text).toContain('"dois"');
    expect(text).toContain('"tres"');
  });

  it("refuses a file it cannot identify", async () => {
    const refused = await upload(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00]), "a.png");
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/unsupported/);
  });

  it("gives each harness the image the way it can see it", async () => {
    const { body } = await upload(PNG_1X1, "shot.png");
    const client = new Client({ name: "t", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    try {
      const call = (agent: string, inline?: boolean) =>
        client.callTool({ name: "room_attachment", arguments: { room: "r", agent, id: body.attachment!.id, inline } }) as Promise<{
          content: { type: string; text?: string; data?: string }[];
        }>;

      const forClaude = await call("claude");
      expect(forClaude.content.map((c) => c.type)).toEqual(["text"]);
      expect(JSON.parse(forClaude.content[0].text!).howToView).toMatch(/Read/);

      const forAgy = await call("agy");
      expect(forAgy.content.map((c) => c.type)).toEqual(["text", "image"]);
      expect(forAgy.content[1].data).toBe(PNG_1X1.toString("base64"));

      expect((await call("claude", true)).content.map((c) => c.type)).toEqual(["text", "image"]);
    } finally {
      await client.close();
    }
  });
});

describe("console attachments", () => {
  it("sends attachments whose tokens are in the line, in their place", () => {
    const composer = new Composer();
    const img = composer.attach({ id: "att_1", name: "a.png", mime: "image/png", bytes: 2048, width: 1, height: 1, path: "/x", createdAt: 0 });
    const pdf = composer.attach({ id: "att_2", name: "b.pdf", mime: "application/pdf", bytes: 10, width: null, height: null, path: "/y", createdAt: 0 });
    expect([img, pdf]).toEqual(["[Image #1]", "[PDF #2: b.pdf]"]);
    expect(composer.takeAll(`olha ${img} só`)).toEqual({ message: "olha [image: a.png] só", attachmentIds: ["att_1"] });
    expect(composer.empty).toBe(true);
  });

  it("turns Ctrl+V and an empty paste into a clipboard read", () => {
    const stream = createPasteStream();
    const events: string[] = [];
    let forwarded = "";
    stream.on("clipboard", () => events.push("clipboard"));
    stream.on("paste", () => events.push("paste"));
    stream.on("data", (chunk) => (forwarded += chunk.toString()));
    stream.write(`ab\u0016c${PASTE_START}${PASTE_END}`);
    expect(events).toEqual(["clipboard", "clipboard"]);
    expect(forwarded).toBe("abc");
  });

  it("recognises a dragged image path, and nothing else", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airoom-drop-"));
    const file = path.join(dir, "my shot.png");
    fs.writeFileSync(file, PNG_1X1);
    try {
      expect(pastedFilePath(file.replace(/ /g, "\\ "))).toBe(file);
      expect(pastedFilePath(`'${file}'`)).toBe(file);
      expect(pastedFilePath(`olha ${file}`)).toBeNull();
      expect(pastedFilePath(path.join(dir, "missing.png"))).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("checks /file before reading it", () => {
    expect(() => readAttachableFile(os.tmpdir())).toThrow(/not a regular file/);
  });

  it("reads a Linux clipboard image through the tool that is there", () => {
    const calls: string[][] = [];
    const result = readClipboard({
      platform: "linux",
      env: { WAYLAND_DISPLAY: "wayland-0" },
      has: (bin) => bin === "wl-paste",
      run: (bin, args) => {
        calls.push([bin, ...args]);
        return args.includes("--list-types")
          ? { status: 0, stdout: Buffer.from("text/plain\nimage/png\n") }
          : { status: 0, stdout: PNG_1X1 };
      },
    });
    expect(result.kind).toBe("image");
    expect(calls[1]).toEqual(["wl-paste", "--no-newline", "--type", "image/png"]);
  });

  it("pastes clipboard text as text instead of reading it as a file path", () => {
    // AppleScript coerces plain text to a file URL, which made a text paste
    // try to attach "/<the text>".
    const run = (bin: string) =>
      bin === "osascript" ? { status: 0, stdout: Buffer.from("text\n") } : { status: 0, stdout: Buffer.from("[Q-05] The new default") };
    expect(readClipboard({ platform: "darwin", run })).toEqual({ kind: "text", text: "[Q-05] The new default" });
  });

  it("attaches a file copied in Finder", () => {
    const run = () => ({ status: 0, stdout: Buffer.from("file:/Users/me/shot.png\n") });
    expect(readClipboard({ platform: "darwin", run })).toEqual({ kind: "file", path: "/Users/me/shot.png" });
  });

  it("pastes Linux clipboard text when there is no image", () => {
    const result = readClipboard({
      platform: "linux",
      env: { WAYLAND_DISPLAY: "wayland-0" },
      has: (bin) => bin === "wl-paste",
      run: (_bin, args) =>
        args.includes("--list-types")
          ? { status: 0, stdout: Buffer.from("text/plain;charset=utf-8\n") }
          : { status: 0, stdout: Buffer.from("ola") },
    });
    expect(result).toEqual({ kind: "text", text: "ola" });
  });

  it("says why there is no clipboard over SSH", () => {
    const result = readClipboard({ platform: "linux", env: {}, has: () => false });
    expect(result).toMatchObject({ kind: "none" });
    if (result.kind === "none") expect(result.reason).toMatch(/\/file/);
  });
});
