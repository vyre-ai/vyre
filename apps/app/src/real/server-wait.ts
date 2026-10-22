// A paired server that does not answer is asked for at most SERVER_WAIT_MS, then remembered as quiet for QUIET_FOR_MS so the next call does not ask it again.
// One server staying silent never holds the others: the caller gets what answered, and a quiet server is skipped until the minute passes.
import { within } from "../../../../lib/within.js";
import { NOT_ANSWERING_SAY } from "./not-answering.js";

/** How long one server may take to answer a fan-out call. */
export const SERVER_WAIT_MS = 4000;
/** How long a server that did not answer stays quiet: it is not asked again until this passes. */
export const QUIET_FOR_MS = 60_000;

const LATE = Symbol("late");
/** A fast refusal that means the server was not reached, as against a tool that answered with an error. */
const SILENT = new Set(["unreachable", "offline", "server_offline", "server_not_answering"]);

let until = new Map<string, number>();
let nowFn = (): number => Date.now();
/** Bumped when the quiet set is reset, so an ask already in flight does not mark a server quiet after the ports changed. */
let era = 0;

/** A test clock. Null restores the real clock. */
export function setServerClock(fn: (() => number) | null): void { nowFn = fn ?? (() => Date.now()); }
/** Forget every quiet server. A test sets fresh ports; a last pairing going away does too. */
export function resetServerQuiet(): void { until = new Map(); era += 1; }

/** True while this server is still inside its quiet minute. An expired mark is dropped. */
export function isQuiet(box: string): boolean {
  const t = until.get(box);
  if (t === undefined) return false;
  if (t <= nowFn()) { until.delete(box); return false; }
  return true;
}

/** The servers currently quiet (box ids). */
export function quietServers(): string[] {
  const out: string[] = [];
  for (const box of [...until.keys()]) if (isQuiet(box)) out.push(box);
  return out;
}

function markQuiet(box: string): void { until.set(box, nowFn() + QUIET_FOR_MS); }
/** The server answered, or the person removed it: ask it again. */
export function clearQuiet(box: string): void { until.delete(box); }

export type Asked<T> = { status: "ok"; value: T } | { status: "quiet" } | { status: "down"; error: unknown };

/**
 * Ask one server. A quiet server is not asked. One that does not answer within SERVER_WAIT_MS, or that cannot be reached, is marked quiet.
 * A tool that answers with its own error is not: the server was there.
 */
export async function askBox<T>(call: () => Promise<T>, box: string): Promise<Asked<T>> {
  if (isQuiet(box)) return { status: "quiet" };
  const mine = era;
  try {
    const value = await within(call(), SERVER_WAIT_MS, LATE);
    if (mine !== era) return { status: "down", error: Object.assign(new Error("cancelled"), { code: "cancelled" }) };
    if (value === LATE) {
      markQuiet(box);
      return { status: "down", error: Object.assign(new Error(NOT_ANSWERING_SAY), { code: "server_not_answering" }) };
    }
    clearQuiet(box);
    return { status: "ok", value: value as T };
  } catch (error) {
    if (mine !== era) return { status: "down", error };
    const code = (error as { code?: string } | null)?.code;
    if (code && SILENT.has(code)) markQuiet(box);
    return { status: "down", error };
  }
}
