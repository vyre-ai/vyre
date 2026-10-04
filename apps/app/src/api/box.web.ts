// The box connection on the web target: relay/client's paths as the transport (the box's origin
// directly, then the relay when this browser is paired), core/resilience/web.js over() for the
// stream and the tool calls on whichever path answers, the outbox and cursor in IndexedDB, and the
// page lifecycle. At the box's own origin (the app at /app/) the person cookie rides along on the
// direct path by itself; at another origin every request is signed with the person session
// (src/auth/person.web.ts), over the box's own path so a relay route never enters the proof.

import { cursorStore, idbStore, lifecycle, over } from "@vyre/resilience/web.js";
import { createPaths } from "@vyre/relay-client/paths.js";
import { finishSignIn, startSignIn, webPerson } from "../auth/person.web";
import type { PersonSession } from "../auth/person";
import { connection } from "../state/connection";
import { relayCrypto, relayKeyStore, loadPairing, about } from "./relay";
import { makeBox } from "./wire";

let base = "";
let paths: string[] | undefined;
let person: PersonSession | null = null;
/** The paths layer's fetch (direct, then the relay): what post() uses for the few routes that are not tool calls. */
let pathFetch: ReturnType<typeof createPaths>["fetch"] | null = null;

/** The box's origin; "" (the default) is this page's origin, where the box serves the app. */
export function configure(o: { base?: string; paths?: string[] }): void {
  if (o.base !== undefined) base = o.base.replace(/\/+$/, "");
  if (o.paths) paths = o.paths;
}

/** The box's origin (scheme, host, port): where a ticketed stream or a terminal page is reached directly. */
export const boxOrigin = () => (base ? new URL(base).origin : location.origin);
const crossOrigin = () => boxOrigin() !== location.origin;

/** The box's host name: what its stores on this device (outbox, cursor, view cache) are keyed by. */
export function boxName(): string {
  return new URL(boxOrigin()).host;
}

const b = makeBox(async () => {
  const origin = boxOrigin();
  const name = boxName();
  person = crossOrigin() ? webPerson(origin, () => connection.signIn(true)) : null;
  const pairing = await loadPairing();
  const direct = (paths?.length ? paths : [origin]).map((p) => ({ kind: "direct" as const, base: p }));
  const p = createPaths({
    paths: pairing ? [...direct, { kind: "relay" as const, ...pairing, about, keyStore: relayKeyStore(), crypto: relayCrypto() }] : direct,
  });
  const o = over(p.fetch);
  pathFetch = p.fetch;
  // Which path answers, for what may not go over the relay (Glass stills).
  p.onstate = (st) => connection.path(st.kind);
  connection.path(p.current);
  return {
    base: origin,
    // One path for follow(): which way the box is reached is the paths layer's job.
    paths: ["box"],
    socket: (path) => p.socket(path),
    open: o.open,
    caller: (_base, co) => o.caller(co),
    outboxStore: idbStore(name),
    cursor: cursorStore(name),
    auth: person,
    async before() {
      if (person && (await finishSignIn(origin, person))) connection.signIn(false);
    },
    lifecycle(c) {
      const net = () => connection.online(navigator.onLine !== false);
      net();
      addEventListener("online", net);
      addEventListener("offline", net);
      const off = lifecycle(c.stream, { outbox: { kick: () => c.kick() } });
      return () => {
        off();
        removeEventListener("online", net);
        removeEventListener("offline", net);
        p.close();
      };
    },
  };
});

export const { connect, listen, call, send, prove, disconnect, socket } = b;

/**
 * One POST of JSON to a box route that is not a tool call (the presence challenge), on whichever path
 * answers, signed as the person like every other request. Resolves the parsed body, never throws on a status.
 */
export async function post(path: string, input: Record<string, unknown>): Promise<{ data?: unknown; error?: { code?: string; message?: string } }> {
  await connect();
  if (!pathFetch) return { error: { code: "offline", message: "no path to the box" } };
  const body = JSON.stringify(input);
  const h = person ? await person.headers("POST", path, body) : {};
  try {
    const r = await pathFetch(path, { method: "POST", cache: "no-store", headers: { "content-type": "application/json", ...h }, body });
    return JSON.parse(await r.text()) as never;
  } catch (e) {
    return { error: { code: "offline", message: (e as Error).message } };
  }
}

/**
 * A hint the page may not outlive (push.seen on hide): straight to the box's origin with
 * keepalive, so it is sent even as the page goes. Never queued, never thrown.
 */
export async function beacon(tool: string, input: Record<string, unknown>): Promise<void> {
  const origin = boxOrigin();
  const path = "/v1/tools/" + encodeURIComponent(tool);
  const body = JSON.stringify(input);
  try {
    const h = person ? await person.headers("POST", path, body) : {};
    await fetch(origin + path, { method: "POST", keepalive: true, credentials: "same-origin", headers: { "content-type": "application/json", ...h }, body });
  } catch {}
}

/** Sign in as the person: the box's passkey page at another origin, its own at the same one. */
export async function signIn(): Promise<void> {
  const origin = boxOrigin();
  if (crossOrigin()) await startSignIn(origin, { force: true });
  else location.assign(`${origin}/person/signin`);
}

/** End the person session on the box. */
export async function signOut(): Promise<void> {
  const origin = boxOrigin();
  if (person) await person.end();
  else await fetch(`${origin}/v1/person/end`, { method: "POST", credentials: "same-origin" }).catch(() => {});
  connection.signIn(true);
}
