// What a scanned code is, in plain terms (pure; scan.ts and scan.web.ts feed it). A Wink code today
// is the long pairing code (`vyre://wink/2?t=...`) or a pairing offer: `https://vyre.run/pair#...`, alone or wrapped in a vyre:// or app link
// (src/api/pairing.ts offerFrom reads all of them). Anything else the camera reads is handed back
// as text, never acted on.

import { parseWinkCode } from "../api/wink-code.ts";

export type ScannedCode =
  | { kind: "pair"; offer: string }
  | { kind: "wink"; ticket: string; relay: string; for: "server" | "phone" }
  | { kind: "other"; text: string };

/** The longest text kept from a code we do not know; a QR can hold far more than a person needs to see. */
export const MAX_OTHER = 512;

export function readCode(text: string | null | undefined): ScannedCode | null {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  const w = parseWinkCode(raw);
  if (w.ok && w.kind === "offer") return { kind: "pair", offer: w.offer };
  if (w.ok) return { kind: "wink", ticket: w.ticket, relay: w.relay, for: w.for };
  return { kind: "other", text: raw.slice(0, MAX_OTHER) };
}

/** Camera access as the screen needs to say it. */
export type CameraState = "granted" | "denied" | "ask" | "unavailable";

export type ScanSupport = {
  state: CameraState;
  /** One plain sentence for the screen when state is not "granted". */
  say: string;
};

export const SAY: Record<CameraState, string> = {
  granted: "The camera is ready.",
  ask: "Vyre needs the camera to read the code on the other screen.",
  denied: "The camera is off for Vyre. Turn it on in your phone's settings, then come back.",
  unavailable: "This device has no camera Vyre can use here.",
};

export const support = (state: CameraState): ScanSupport => ({ state, say: SAY[state] });

/** Reads each code once: a camera reports the same code many times a second. */
export function onceEach(handle: (c: ScannedCode) => void, hold = 1500, now: () => number = Date.now) {
  let last = "";
  let at = -Infinity;
  return (text: string | null | undefined) => {
    const c = readCode(text);
    if (!c) return;
    const key = c.kind === "pair" ? c.offer : c.kind === "wink" ? c.ticket : c.text;
    const t = now();
    if (key === last && t - at < hold) return;
    last = key;
    at = t;
    handle(c);
  };
}
