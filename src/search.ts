import type { MessageInfo } from "./types.js";

const pad = (n: number) => String(n).padStart(2, "0");

/** Local time, minutes precision: what a human scanning results reads by. */
export function localStamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** One line of the content around the first match, so a long message still shows why it matched. */
export function snippet(content: string, text: string, width = 100): string {
  const flat = content.replace(/\s+/g, " ").trim();
  const at = flat.toLowerCase().indexOf(text.toLowerCase());
  if (flat.length <= width) return flat;
  const start = Math.max(0, Math.min(at < 0 ? 0 : at - Math.floor((width - text.length) / 2), flat.length - width));
  return `${start > 0 ? "…" : ""}${flat.slice(start, start + width)}${start + width < flat.length ? "…" : ""}`;
}

/** `<room>  <agent>  #<id>  <local date>  <snippet>` */
export function searchLine(message: MessageInfo, text: string): string {
  return `${message.room}  ${message.agent}  #${message.id}  ${localStamp(message.createdAt)}  ${snippet(message.content, text)}`;
}
