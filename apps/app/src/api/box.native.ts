// The box connection on the phone: relay/client's paths as the transport. The relay is the path
// the phone always has once paired; the box's direct address (the tailnet, the LAN), when
// configured, is tried first and used while it answers within 1.5 s. The stream and the tool calls
// go through core/resilience/web.js over() on whichever path answers. The outbox and cursor are in
// memory until MMKV or SQLite lands behind the same {load, save}. The app state pauses the stream
// in the background and resumes it in front, as the page lifecycle does on the web.
// The person session is src/auth/person.native.ts: the key in the Keystore or the Secure
// Enclave (modules/vyre-signer), the token in the secure store, sign-in through the system's
// authentication browser on the direct path, the biometric key's device sign-in on the relay
// (no browser). It exists once the phone is paired or has the box's direct address, and keeps a
// token per path, since the box pins each to the tailnet node or the relay device.
// HUMAN_ONLY calls carry the biometric key's presence proof; the presence session the box answers
// with (x-vyre-presence-session, on any path) is kept from here, so the next sessionable call goes
// with it and no prompt.

import { AppState } from "react-native";
import { over } from "@vyre/resilience/web.js";
import { memoryStore } from "@vyre/resilience/outbox.js";
import { createPaths } from "@vyre/relay-client/paths.js";
import { nativePerson, type NativePerson, type Send } from "../auth/person.native";
import { connection } from "../state/connection";
import { relayBase, type Pairing } from "./pairing";
import { about, directFetch, loadPairing, relayCrypto, relayKeyStore, visibility } from "./relay";
import { makeBox } from "./wire";

let base = "";
let paths: string[] | undefined;
let cursor: number | null = null;
let person: NativePerson | null = null;

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

/** The box's origin when it is reached directly; "" when only the relay reaches it. */
export function boxOrigin(): string {
  try {
    return base ? new URL(base).origin : "";
  } catch {
    return "";
  }
}

const store = memoryStore();

// The biometric key is enrolled at the native sign-in and proves HUMAN_ONLY calls (e2e, ADR 0032).
// The prompt shows only for those, and only when no live presence session covers the call.
// The box pins presence sessions to the path (the tailnet node, or the relay device): one per path.
let pathNow = () => (base ? "direct" : "relay");
/** A box path over whichever path answers (set at connect); the relay sign-in and sign-out go through it. */
let transport: Send | null = null;
const makePerson = (at: string) =>
  nativePerson(at, () => connection.signIn(true), {
    onSignedIn: (ok) => ok && connection.signIn(false),
    path: () => pathNow(),
    send: (path, init) => (transport ? transport(path, init) : Promise.reject(new Error("not connected to the box"))),
    name: boxName(),
    route: paired ? paired.route : undefined,
  });
/** Where the person session was made for, so a new pairing makes a new one. */
let personAt = "";
/** The person session: at the direct address when there is one, else at the relay's route. */
const ensurePerson = (): NativePerson | null => {
  const at = base || (paired ? relayBase(paired) : "");
  if (at && (!person || personAt !== at)) {
    person = makePerson(at);
    personAt = at;
  }
  return at ? person : null;
};

const b = makeBox(async () => {
  paired = await loadPairing();
  if (!base && !paired) throw new Error("pair with the box, or configure({ base }) with its address, first");
  ensurePerson();
  const direct = (paths?.length ? paths : base ? [base] : []).map((p) => ({ kind: "direct" as const, base: p }));
  const p = createPaths({
    paths: [...direct, ...(paired ? [{ kind: "relay" as const, ...paired, about, keyStore: relayKeyStore(), crypto: relayCrypto() }] : [])],
    fetch: directFetch,
    visibility,
  });
  pathNow = () => p.current;
  // Which path answers, for what may not go over the relay (Glass stills).
  p.onstate = (st) => connection.path(st.kind);
  connection.path(p.current);
  transport = (path, init) => p.fetch(path, init);
  // A proof sent with x-vyre-presence-keep opens a presence session; the box names it in a header
  // the tool caller does not pass on, so it is read here.
  const o = over(async (path, init) => {
    const r = await p.fetch(path, init);
    if (init.headers?.["x-vyre-presence-keep"] === "1") {
      const h = (r as { headers?: { get?: (n: string) => string | null } }).headers?.get?.("x-vyre-presence-session");
      if (h && person) await person.presence.keep(h);
    }
    return r;
  });
  return {
    base: base || relayBase(paired as Pairing),
    // One path for follow(): which way the box is reached is the paths layer's job.
    paths: ["box"],
    socket: (path) => p.socket(path),
    open: o.open,
    caller: (_base, co) => o.caller(co),
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
      return () => {
        sub.remove();
        p.close();
      };
    },
  };
});

export const { connect, listen, call, send, prove, disconnect, socket } = b;

/** The phone proves presence with its biometric key inside call(); it has no route of its own to post. */
export async function post(_path: string, _input: Record<string, unknown>): Promise<{ data?: unknown; error?: { code?: string; message?: string } }> {
  return { error: { code: "unsupported", message: "this build proves presence with its device key" } };
}

/** A hint that need not outlive the app (push.seen): one call, never queued, never thrown. */
export async function beacon(tool: string, input: Record<string, unknown>): Promise<void> {
  await b.call(tool, input).catch(() => {});
}

/**
 * Sign in as the person on the current path: the box's passkey page in the system's authentication
 * browser on the direct one, one biometric prompt on the relay.
 */
export async function signIn(): Promise<void> {
  if (!base && !paired) paired = await loadPairing();
  const s = ensurePerson();
  if (!s) throw new Error("pair with the box, or configure({ base }) with its address, first");
  await s.signIn({ force: true });
}

/** End the person session on the box. */
export async function signOut(): Promise<void> {
  if (person) await person.end();
  connection.signIn(true);
}
