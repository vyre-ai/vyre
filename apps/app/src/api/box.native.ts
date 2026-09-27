// The box connection on the phone: relay/client's paths as the transport. The relay is the path
// the phone always has once paired; the box's direct address (the tailnet, the LAN), when
// configured, is tried first and used while it answers within 1.5 s. The stream and the tool calls
// go through core/resilience/web.js over() on whichever path answers. The outbox and cursor are in
// memory until MMKV or SQLite lands behind the same {load, save}. The app state pauses the stream
// in the background and resumes it in front, as the page lifecycle does on the web.
// The person session is src/auth/person.native.ts: the key in the Keystore or the Secure
// Enclave (modules/vyre-signer), the token in the secure store, sign-in through the system's
// authentication browser. It needs the box's direct address, so a relay-only phone goes without.

import { AppState } from "react-native";
import { over } from "@vyre/resilience/web.js";
import { memoryStore } from "@vyre/resilience/outbox.js";
import { createPaths } from "@vyre/relay-client/paths.js";
import type { PersonSession } from "../auth/person.ts";
import { finishSignIn, nativePerson, startSignIn } from "../auth/person.native";
import { connection } from "../state/connection";
import { relayBase, type Pairing } from "./pairing";
import { about, directFetch, loadPairing, relayCrypto, relayKeyStore, visibility } from "./relay";
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

/** The pairing read at connect; its route names a relay-only box. */
let paired: Pairing | null = null;

/** The box's host name, or its relay route: what its stores on this device are keyed by ("" before either). */
export function boxName(): string {
  try {
    return base ? new URL(base).host : paired ? paired.route : "";
  } catch {
    return "";
  }
}

const store = memoryStore();

// human: false until the box verifies the biometric key (e2e, ADR 0032): a prompt the box ignores
// would be nagging for nothing.
const makePerson = () => nativePerson(base, () => connection.signIn(true), { onSignedIn: (ok) => ok && connection.signIn(false), human: false });

const b = makeBox(async () => {
  paired = await loadPairing();
  if (!base && !paired) throw new Error("pair with the box, or configure({ base }) with its address, first");
  if (base) person ??= makePerson();
  const direct = (paths?.length ? paths : base ? [base] : []).map((p) => ({ kind: "direct" as const, base: p }));
  const p = createPaths({
    paths: [...direct, ...(paired ? [{ kind: "relay" as const, ...paired, about, keyStore: relayKeyStore(), crypto: relayCrypto() }] : [])],
    fetch: directFetch,
    visibility,
  });
  const o = over(p.fetch);
  return {
    base: base || relayBase(paired as Pairing),
    // One path for follow(): which way the box is reached is the paths layer's job.
    paths: ["box"],
    open: o.open,
    caller: (_base, co) => o.caller(co),
    outboxStore: store,
    auth: base ? person : null,
    cursor: { load: () => cursor, save: (n: number) => void (cursor = n) },
    lifecycle(c) {
      const sub = AppState.addEventListener("change", (s) => {
        if (s === "active") {
          c.stream?.resume();
          c.kick();
        } else if (s === "background") c.stream?.pause();
      });
      return () => {
        sub.remove();
        p.close();
      };
    },
  };
});

export const { connect, listen, call, send, prove, disconnect } = b;

/** A hint that need not outlive the app (push.seen): one call, never queued, never thrown. */
export async function beacon(tool: string, input: Record<string, unknown>): Promise<void> {
  await b.call(tool, input).catch(() => {});
}

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
