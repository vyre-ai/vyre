// The box connection on the phone: the stream over XHR (native-open.ts), tool calls through
// core/resilience/web.js caller (plain fetch, which React Native has), and the outbox and cursor
// in memory until MMKV or SQLite lands behind the same {load, save}. The app state pauses the
// stream in the background and resumes it in front, as the page lifecycle does on the web.
// The person session is src/auth/person.native.ts: the key in the Keystore or the Secure
// Enclave (modules/vyre-signer), the token in the secure store, sign-in through the system's
// authentication browser.

import { AppState } from "react-native";
import { caller } from "@vyre/resilience/web.js";
import { memoryStore } from "@vyre/resilience/outbox.js";
import type { PersonSession } from "../auth/person.ts";
import { finishSignIn, nativePerson, startSignIn } from "../auth/person.native";
import { connection } from "../state/connection";
import { open } from "./native-open";
import { makeBox } from "./wire";

let base = "";
let paths: string[] | undefined;
let cursor: number | null = null;
let person: PersonSession | null = null;

/** The box's https address. The phone has no page origin, so this is required before connect(). */
export function configure(o: { base?: string; paths?: string[] }): void {
  if (o.base !== undefined && o.base.replace(/\/+$/, "") !== base) {
    base = o.base.replace(/\/+$/, "");
    person = null;
  }
  if (o.paths) paths = o.paths;
}

/** The box's host name: what its stores on this device are keyed by ("" before configure). */
export function boxName(): string {
  try {
    return base ? new URL(base).host : "";
  } catch {
    return "";
  }
}

const store = memoryStore();

// human: false until the box verifies the biometric key (e2e, ADR 0032): a prompt the box ignores
// would be nagging for nothing.
const makePerson = () => nativePerson(base, () => connection.signIn(true), { onSignedIn: (ok) => ok && connection.signIn(false), human: false });

const b = makeBox(async () => {
  if (!base) throw new Error("configure({ base }) with the box's address first");
  person ??= makePerson();
  return {
    base,
    paths,
    open,
    caller,
    outboxStore: store,
    auth: person,
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

/** Sign in as the person: the box's passkey page in the system's authentication browser. */
export async function signIn(): Promise<void> {
  if (!base) throw new Error("configure({ base }) with the box's address first");
  const origin = new URL(base).origin;
  person ??= makePerson();
  await startSignIn(origin, { force: true });
  if (await finishSignIn(origin, person)) connection.signIn(false);
}

/** End the person session on the box. */
export async function signOut(): Promise<void> {
  if (person) await person.end();
  connection.signIn(true);
}
