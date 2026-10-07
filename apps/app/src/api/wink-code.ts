// The long Wink code, read in one place (pure; Node tests it). A server prints it and shows it as a QR,
// a computer shows it as a QR for a phone: `vyre://wink/2?t=<16-byte secret>&r=<relay>[&k=phone]`.
// The older relay offer (`https://vyre.run/pair#...`, src/api/pairing.ts) still reads as a long code.
// A short typed code (`WINK-XXXX-XXXX`) is refused: the server does not accept one in this release
// (DESIGN-wink.md section 4), and the words below are what the person is told.

import { offerFrom } from "./pairing.ts";

export type WinkCode =
  | { ok: true; kind: "ticket"; ticket: string; relay: string; for: "server" | "phone" }
  | { ok: true; kind: "offer"; offer: string }
  /** The short typed code, WINK-NNPP-PPPP: the other device types it instead of scanning or pasting the long link (relay/client/code.js). */
  | { ok: true; kind: "typed"; code: string }
  | { ok: false; reason: "empty" | "typed" | "not_a_code"; say: string };

export const SAY = {
  empty: "Paste the long code the screen shows, or scan its QR.",
  typed: "That is an old kind of code that no longer works. Scan the code on the screen, type its new short code, or paste the long code it shows.",
  not_a_code: "That is not a Vyre code. Scan the code on the screen, or paste the long code it printed.",
} as const;

/** 16 bytes in base64url is 22 characters. */
const SECRET = /^[A-Za-z0-9_-]{22}$/;
/** The short form people used to type: WINK-7K4Q-M2XD, with or without the dashes. */
const TYPED = /^WINK-?[A-Z0-9]{4}-?[A-Z0-9]{4}$/i;

const refuse = (reason: "empty" | "typed" | "not_a_code"): WinkCode => ({ ok: false, reason, say: SAY[reason] });

export function parseWinkCode(text: string | null | undefined): WinkCode {
  const raw = String(text ?? "").trim();
  if (!raw) return refuse("empty");
  const long = /^vyre:\/\/wink\/2\?(.*)$/.exec(raw);
  if (long) {
    const q = new URLSearchParams(long[1]);
    const t = q.get("t") ?? "";
    if (!SECRET.test(t)) return refuse("not_a_code");
    return { ok: true, kind: "ticket", ticket: t, relay: q.get("r") ?? "", for: q.get("k") === "phone" ? "phone" : "server" };
  }
  const offer = offerFrom(raw);
  if (offer) return { ok: true, kind: "offer", offer };
  const t = TYPED.exec(raw.replace(/\s+/g, ""));
  if (t) { const b = raw.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(4); return { ok: true, kind: "typed", code: `WINK-${b.slice(0, 4)}-${b.slice(4)}` }; }
  if (/^vyre:\/\/wink\/1\?/.test(raw)) return refuse("typed");
  return refuse("not_a_code");
}

/** The sample long code the mock store shows (a made-up secret, no real relay). */
export const SAMPLE_CODE = "vyre://wink/2?t=SGVsbG9TYW1wbGVTZWNyZQ&r=wss%3A%2F%2Frelay.example";
