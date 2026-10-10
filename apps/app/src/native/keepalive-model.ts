// Notices with the app closed (Android): when the app asks the system to keep its connection to the home alive, and what the Settings row says. Pure; the native side is src/native/keepalive.ts.
// No Firebase, no push service, no token: a foreground service holds the app's own connection (modules/vyre-notify, KeepAliveService), and the notice loop (notices.ts) runs in it.

export type Permission = "granted" | "ask" | "denied" | "unavailable";
export type KeepState = "on" | "off" | "ask" | "denied" | "unavailable";

/** What to do about the kept connection: start it (notices on, allowed), stop it (the person turned it off), or leave it. */
export function keepPlan(i: { android: boolean; permission: Permission; wanted: boolean }): "start" | "stop" | "nothing" {
  if (!i.android) return "nothing";
  if (i.permission === "granted") return i.wanted ? "start" : "stop";
  return "nothing";
}

/** The state the Settings row shows. */
export function keepState(i: { android: boolean; permission: Permission; wanted: boolean }): KeepState {
  if (!i.android || i.permission === "unavailable") return "unavailable";
  if (i.permission === "ask") return "ask";
  if (i.permission === "denied") return "denied";
  return i.wanted ? "on" : "off";
}

/** The words of the row, in the app's plain voice. */
export const KEEP_SAY: Record<KeepState, { value: string; line: string }> = {
  on: { value: "On", line: "Vyre stays connected to your home when the app is closed, and tells you when something needs you." },
  off: { value: "Off", line: "You hear about what needs you when you open the app." },
  ask: { value: "Allow", line: "Allow notices so Vyre can tell you when something needs you, even when the app is closed." },
  denied: { value: "Blocked", line: "Notices are blocked for Vyre in the phone's settings." },
  unavailable: { value: "", line: "" },
};

/** What a tap on the row does. */
export function keepTap(s: KeepState): "ask" | "turn-off" | "turn-on" | "open-settings" | "nothing" {
  return s === "ask" ? "ask" : s === "on" ? "turn-off" : s === "off" ? "turn-on" : s === "denied" ? "open-settings" : "nothing";
}
