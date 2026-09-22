import { Transform } from "node:stream";

/**
 * Where a paste begins and ends, straight from the terminal.
 *
 * A terminal that is asked to (DECSET 2004) wraps pasted text in these two
 * markers and delivers it as one write. That boundary is the only honest way to
 * tell a paste from someone typing quickly: timing heuristics break for a slow
 * paste and for a fast typist alike. Node's readline throws the markers away
 * and still splits on every newline, so the filter has to run before it.
 */
export const PASTE_START = "\u001b[200~";
export const PASTE_END = "\u001b[201~";
export const ENABLE_BRACKETED_PASTE = "\u001b[?2004h";
export const DISABLE_BRACKETED_PASTE = "\u001b[?2004l";

/** A paste larger than this degrades to plain input instead of being buffered. */
export const MAX_PASTE_BYTES = 1024 * 1024;

/** Terminals send CR inside a paste; a room message wants real newlines. */
export function normalizePaste(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export interface FilterResult {
  /** What readline should still see: everything that was not a paste. */
  forward: string;
  /** Complete pastes, in order, already normalized. */
  pastes: string[];
}

/**
 * Splits a raw terminal stream into ordinary input and whole pastes. Markers can
 * be cut in half between two reads, so both the markers and the payload are
 * carried across chunks.
 */
export class PasteFilter {
  private inside = false;
  private buffer = "";
  private pending = "";

  feed(chunk: string): FilterResult {
    let data = this.pending + chunk;
    this.pending = "";
    let forward = "";
    const pastes: string[] = [];

    for (;;) {
      if (!this.inside) {
        const start = data.indexOf(PASTE_START);
        if (start === -1) {
          // A chunk may end mid-marker; hold just enough to recognise it next time.
          const keep = partialSuffix(data, PASTE_START);
          forward += data.slice(0, data.length - keep);
          this.pending = data.slice(data.length - keep);
          break;
        }
        forward += data.slice(0, start);
        data = data.slice(start + PASTE_START.length);
        this.inside = true;
        this.buffer = "";
        continue;
      }

      const end = data.indexOf(PASTE_END);
      if (end === -1) {
        this.buffer += data;
        if (this.buffer.length > MAX_PASTE_BYTES) {
          // Too large to hold: give it back as ordinary input rather than grow
          // without bound. The console says so; nothing is lost.
          forward += this.buffer;
          this.buffer = "";
          this.inside = false;
        }
        break;
      }

      this.buffer += data.slice(0, end);
      pastes.push(normalizePaste(this.buffer));
      this.buffer = "";
      this.inside = false;
      data = data.slice(end + PASTE_END.length);
    }

    return { forward, pastes };
  }

  /** True while a paste is still arriving. */
  get buffering(): boolean {
    return this.inside;
  }
}

/** Length of the longest suffix of `data` that could start `marker`. */
function partialSuffix(data: string, marker: string): number {
  const max = Math.min(marker.length - 1, data.length);
  for (let size = max; size > 0; size -= 1) {
    if (marker.startsWith(data.slice(data.length - size))) return size;
  }
  return 0;
}

/** Ctrl+V as the terminal sends it in raw mode. */
export const CTRL_V = "\u0016";

/**
 * The stream readline reads from. Pastes never reach it: they are announced on
 * the returned stream as "paste" events, so one paste stays one thing instead
 * of becoming one message per line.
 *
 * Ctrl+V and an empty paste are announced as "clipboard": a terminal cannot
 * deliver an image, and with only an image on the clipboard some terminals
 * send an empty paste, so both mean "go read the clipboard".
 */
export function createPasteStream(): Transform {
  const filter = new PasteFilter();
  return new Transform({
    transform(chunk, _encoding, done) {
      const { forward, pastes } = filter.feed(chunk.toString("utf8"));
      for (const paste of pastes) this.emit(paste.length ? "paste" : "clipboard", paste);
      const presses = forward.split(CTRL_V).length - 1;
      for (let i = 0; i < presses; i += 1) this.emit("clipboard");
      done(null, presses ? forward.split(CTRL_V).join("") : forward);
    },
  });
}
