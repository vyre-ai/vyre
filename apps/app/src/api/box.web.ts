// The box connection on the web target: core/resilience/web.js for the stream's transport, the
// tool caller, the outbox and cursor in IndexedDB, and the page lifecycle. At the box's own
// origin (the app at /app/) the person cookie rides along by itself; at another origin every
// request is signed with the person session (src/auth/person.web.ts).

import { caller, cursorStore, idbStore, lifecycle, open } from "@vyre/resilience/web.js";
import { finishSignIn, startSignIn, webPerson } from "../auth/person.web";
import type { PersonSession } from "../auth/person";
import { connection } from "../state/connection";
import { makeBox } from "./wire";

let base = "";
let paths: string[] | undefined;
let person: PersonSession | null = null;

/** The box's origin; "" (the default) is this page's origin, where the box serves the app. */
export function configure(o: { base?: string; paths?: string[] }): void {
  if (o.base !== undefined) base = o.base.replace(/\/+$/, "");
  if (o.paths) paths = o.paths;
}

const boxOrigin = () => (base ? new URL(base).origin : location.origin);
const crossOrigin = () => boxOrigin() !== location.origin;

/** The box's host name: what its stores on this device (outbox, cursor, view cache) are keyed by. */
export function boxName(): string {
  return new URL(boxOrigin()).host;
}

const b = makeBox(async () => {
  const origin = boxOrigin();
  const name = boxName();
  person = crossOrigin() ? webPerson(origin, () => connection.signIn(true)) : null;
  const cursor = cursorStore(name);
  return {
    base: origin,
    paths,
    open,
    caller,
    outboxStore: idbStore(name),
    cursor,
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
      };
    },
  };
});

export const { connect, listen, call, send, prove, disconnect } = b;

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
