// The box connection on the phone: the stream over XHR (native-open.ts), tool calls through
// core/resilience/web.js caller (plain fetch, which React Native has), and the outbox and cursor
// in memory until MMKV or SQLite lands behind the same {load, save}. The app state pauses the
// stream in the background and resumes it in front, as the page lifecycle does on the web.
// No person session yet: Hermes has no WebCrypto, so the signed session waits for a native key.

import { AppState } from "react-native";
import { caller } from "@vyre/resilience/web.js";
import { memoryStore } from "@vyre/resilience/outbox.js";
import { open } from "./native-open";
import { makeBox } from "./wire";

let base = "";
let paths: string[] | undefined;
let cursor: number | null = null;

/** The box's https address. The phone has no page origin, so this is required before connect(). */
export function configure(o: { base?: string; paths?: string[] }): void {
  if (o.base !== undefined) base = o.base.replace(/\/+$/, "");
  if (o.paths) paths = o.paths;
}

const store = memoryStore();

const b = makeBox(async () => {
  if (!base) throw new Error("configure({ base }) with the box's address first");
  return {
    base,
    paths,
    open,
    caller,
    outboxStore: store,
    cursor: { load: () => cursor, save: (n: number) => void (cursor = n) },
    lifecycle(c) {
      const sub = AppState.addEventListener("change", (s) => {
        if (s === "active") {
          c.stream?.resume();
          c.kick();
        } else if (s === "background") c.stream?.pause();
      });
      return () => sub.remove();
    },
  };
});

export const { connect, listen, call, send, prove, disconnect } = b;

export async function signIn(): Promise<void> {
  throw new Error("signing in on the phone comes with its native key");
}

export async function signOut(): Promise<void> {}
