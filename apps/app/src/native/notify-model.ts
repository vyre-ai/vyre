// Notifications, pure part. Vyre sends nothing to a central server, so there is no push token to
// register anywhere: a notice the app shows is one the app made itself, from an event it already
// holds (a Needs-you row, a finished run). A phone that wants a notice while the app is closed
// needs a transport that is the person's own (their box over the relay, say). That is the
// PushTransport interface below; today the only one is nullTransport.

export type NotifyState = "granted" | "denied" | "ask" | "unavailable";

export type Notice = {
  /** Stable per thing, so a second notice about it replaces the first. */
  id: string;
  title: string;
  body?: string;
  /** Where a tap goes: an app route such as /u/now. */
  route?: string;
};

export const SAY: Record<NotifyState, string> = {
  granted: "Notifications are on.",
  ask: "Turn on notifications to hear when something needs you.",
  denied: "Notifications are off for Vyre. Turn them on in your phone's settings.",
  unavailable: "Notifications are not available here.",
};

const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…");

/** A notice trimmed to what a lock screen shows; null when it has no title (nothing to say). */
export function cleanNotice(n: Notice): Notice | null {
  const title = String(n.title ?? "").replace(/\s+/g, " ").trim();
  if (!title || !n.id) return null;
  const body = n.body ? clip(String(n.body).replace(/\s+/g, " ").trim(), 180) : undefined;
  const route = n.route && n.route.startsWith("/") && !n.route.startsWith("//") ? n.route : undefined;
  return { id: String(n.id), title: clip(title, 60), ...(body ? { body } : {}), ...(route ? { route } : {}) };
}

/** What carries a notice to a closed app. Vyre's own: no vendor push service, no central server. */
export interface PushTransport {
  readonly name: string;
  /** Start listening; `deliver` is called with each notice. Returns a function that stops. */
  start(deliver: (n: Notice) => void): Promise<() => void> | (() => void);
}

export const nullTransport: PushTransport = {
  name: "none",
  start: () => () => {},
};
