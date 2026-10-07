// The web build of notify.ts: the browser's own Notification API, shown only while a tab is open.
// No service-worker push, no token. Where the browser has none, it says so.

import { shell } from "../shell/shell";
import { cleanNotice, nullTransport, SAY, type Notice, type NotifyState, type PushTransport } from "./notify-model.ts";

export type { Notice, NotifyState, PushTransport } from "./notify-model.ts";
export { cleanNotice, nullTransport, SAY } from "./notify-model.ts";

type N = { permission: "default" | "granted" | "denied"; requestPermission(): Promise<"default" | "granted" | "denied"> };
const api = (): N | null => ((globalThis as { Notification?: N }).Notification ?? null);
const stateOf = (p: string): NotifyState => (p === "granted" ? "granted" : p === "denied" ? "denied" : "ask");

let transport: PushTransport = nullTransport;
export const setTransport = (t: PushTransport) => void (transport = t);
export const activeTransport = () => transport;

export async function notifyState(): Promise<{ state: NotifyState; say: string }> {
  const n = api();
  const state = n ? stateOf(n.permission) : "unavailable";
  return { state, say: SAY[state] };
}

export async function requestNotify(): Promise<{ state: NotifyState; say: string }> {
  const n = api();
  if (!n) return { state: "unavailable", say: SAY.unavailable };
  const state = stateOf(await n.requestPermission());
  return { state, say: SAY[state] };
}

export async function showLocal(notice: Notice): Promise<boolean> {
  const c = cleanNotice(notice);
  // The Mac app's window posts it through Notification Center itself.
  const mac = shell();
  if (c && mac) { await mac.notify(c.title, c.body ?? "").catch(() => {}); return true; }
  const n = api();
  if (!c || !n || n.permission !== "granted") return false;
  new (n as unknown as new (t: string, o: { body?: string; tag: string }) => unknown)(c.title, { body: c.body, tag: c.id });
  return true;
}

/** Taps on a web notice focus the tab; routing is the page's own, so there is nothing to subscribe to. */
export function onTap(_go: (route: string) => void): () => void {
  return () => {};
}
