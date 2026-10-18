// Reads the origin of a forked thread once (stream.read, a page of 200 at a time) and returns what it said up to the fork, or null when there is nothing to show (not found, or a private chat this device cannot open).
import { tool } from "../real/box";
import { openPrivateKey } from "./private-text.js";
import { openOriginRows, originRows, type OriginRow } from "./origin-history.js";

const PAGES = 25;

export async function loadOrigin(thread: string, message: string): Promise<OriginRow[] | null> {
  try {
    const frames: unknown[] = [];
    let from = 0;
    for (let i = 0; i < PAGES; i++) {
      const r = await tool<{ frames?: unknown[]; next?: number }>("stream.read", { chat: thread, from, limit: 200 });
      const got = Array.isArray(r?.frames) ? r.frames : [];
      frames.push(...got);
      if (originRows(frames, message).found) break;
      if (!got.length || typeof r?.next !== "number" || r.next === from) break;
      from = r.next;
    }
    const cut = originRows(frames, message);
    if (!cut.found || !cut.rows.length) return null;
    return await openOriginRows(cut.rows, openPrivateKey);
  } catch { return null; }
}

/** The sample world's origin: a short private conversation sealed with a key this device holds, read through the same fold and decrypt as a real one. For the demo route and the shots. */
export async function sampleOrigin(): Promise<OriginRow[] | null> {
  const { holdPrivateKey, resolveDecryptKid, sealUserMessage } = await import("./private-text.js");
  const key = new Uint8Array(32).fill(9);
  holdPrivateKey("sample-origin", key);
  const f = (cur: number, type: string, message: string, data: Record<string, unknown>) => ({ cur, type: "chat." + type, message, data: { message, ...data } });
  const frames = [
    f(1, "user-message", "u1", { enc: sealUserMessage("sample-origin", key, "Fix the failing date check in the intake form.") }),
    f(2, "text-delta", "a1", { text: "The check compares the day against a fixed month table, so it rejects 29 February. " }),
    f(3, "text-delta", "a1", { text: "I will use the real month length instead." }),
    f(4, "text-done", "a1", {}),
    f(5, "user-message", "u2", { text: "After the fork, not shown." }),
  ];
  const cut = originRows(frames, "a1");
  return cut.found ? openOriginRows(cut.rows, resolveDecryptKid) : null;
}
