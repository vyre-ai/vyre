// @ts-check
// door-adapter: what the inference door streams (kernel/door/door.js door.stream, types in
// kernel/contracts/model.d.ts ModelStreamEvent) becomes session frames (ADR 0052). A pure mapping: no
// I/O, no clock, no kernel import.
//
//   text       -> text-delta   (the door holds back about 40 characters; the row shows them as
//                               provisional until text-done, frames.js HOLDBACK)
//   tool_call  -> tool-started (the whole input was scanned; the result is a tool-finished the caller adds)
//   cut        -> text-cut     (the scan found a value: the provisional tail goes, nothing of the value was released)
//   done       -> text-done
//
// Every spec carries the author and acts_for of the asker's chain: [asker, ..., assistant] gives
// acts_for = the first hop (the person) and author = the last (the assistant), the same reading as
// protocol.js toEnvelope. A cut ends the message: later events for it are ignored.

import { kindOfTool, summarize } from "./protocol.js";
import { cutData } from "./viewer.js";

/**
 * @typedef {{ kind: string, data: any, turn?: string|null, author: string, acts_for?: string, message: string }} DoorSpec
 * @param {{ message: string, chain?: readonly string[], author?: string, actsFor?: string, turn?: string|null }} o
 */
export function createDoorAdapter(o) {
  const chain = o.chain || [];
  const author = o.author || chain[chain.length - 1];
  if (!author) throw new Error("a door stream needs an author: the last hop of the chain, or author");
  const first = o.actsFor || (chain.length > 1 ? chain[0] : undefined);
  const actsFor = first && first.startsWith("person:") && first !== author ? first : undefined;
  const message = o.message;
  let index = 0, open = false, over = false;
  /** @param {string} kind @param {any} data @returns {DoorSpec} */
  const spec = (kind, data) => ({ kind, data, turn: o.turn ?? null, author, ...(actsFor ? { acts_for: actsFor } : {}), message });
  return {
    /** @param {{ type: string, [k: string]: any }} ev @returns {DoorSpec[]} */
    event(ev) {
      if (over || !ev) return [];
      switch (ev.type) {
        case "text":
          if (typeof ev.text !== "string" || !ev.text) return [];
          open = true;
          return [spec("text-delta", { message, index, text: ev.text })];
        case "tool_call": {
          const out = [];
          if (open) { out.push(spec("text-done", { message, index })); open = false; index++; } // text after a tool is a new block
          const name = String(ev.name ?? "");
          out.push(spec("tool-started", { tool_id: String(ev.id), tool: name, kind: kindOfTool(name), summary: summarize(name, ev.input) }));
          return out;
        }
        case "cut": {
          over = true; open = false;
          return [spec("text-cut", { ...cutData(message), ...(ev.code ? { code: String(ev.code) } : {}), ...(ev.class ? { class: String(ev.class) } : {}) })];
        }
        case "done": {
          over = true;
          const was = open; open = false;
          return was ? [spec("text-done", { message, index })] : [];
        }
        default: return [];
      }
    },
  };
}

/**
 * Append what one door event makes to a session log.
 * @param {import("./log.js").SessionLog} log @param {ReturnType<typeof createDoorAdapter>} ad @param {any} ev
 */
export function pipeDoor(log, ad, ev) {
  return ad.event(ev).map(s => log.append(s.kind, s.data, { turn: s.turn ?? null, author: s.author, ...(s.acts_for ? { acts_for: s.acts_for } : {}), message: s.message }));
}

/**
 * Drain a door.stream generator into a log, frame by frame as it streams. Returns the frames.
 * @param {import("./log.js").SessionLog} log @param {AsyncIterable<any>} events @param {Parameters<typeof createDoorAdapter>[0]} o
 */
export async function drainDoor(log, events, o) {
  const ad = createDoorAdapter(o);
  const out = [];
  for await (const ev of events) out.push(...pipeDoor(log, ad, ev));
  return out;
}
