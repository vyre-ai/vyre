// The long Wink code, read in one place (pure; Node tests it). A server prints it and shows it as a QR:
// `vyre://wink/2?t=<16-byte secret>&r=<relay>`.
// The older relay offer (`https://vyre.run/pair#...`, alone or wrapped in a vyre:// or app link) is gone:
// the box no longer makes or accepts it, so it is refused with the next step (reason "old_offer").

export type WinkCode =
  | { ok: true; kind: "ticket"; ticket: string; relay: string; for: "server" }
  | { ok: false; reason: "empty" | "old_offer" | "not_a_code"; say: string };

export const SAY = {
  empty: "Paste the long code the screen shows, or scan its QR.",
  old_offer: "That is an old kind of pairing code that no longer works. Make a new install line in the Vyre app.",
  not_a_code: "That is not a Vyre code. Scan the code on the screen, or paste the long code it printed.",
} as const;

/** 16 bytes in base64url is 22 characters. */
const SECRET = /^[A-Za-z0-9_-]{22}$/;

/** The old bearer offer in any wrapping: `https://vyre.run/pair#...`, `vyre://pair?offer=...`, `/app/pair?offer=...`, encoded or not. */
export const isOldOffer = (raw: string): boolean => /(vyre\.run(\/|%2F)pair(#|%23)|pair\?offer=|offer=https?(:|%3A))/i.test(raw) || /^vyre:\/\/pair\b/i.test(raw);

const refuse = (reason: "empty" | "old_offer" | "not_a_code"): WinkCode => ({ ok: false, reason, say: SAY[reason] });

export function parseWinkCode(text: string | null | undefined): WinkCode {
  const raw = String(text ?? "").trim();
  if (!raw) return refuse("empty");
  const long = /^vyre:\/\/wink\/2\?(.*)$/.exec(raw);
  if (long) {
    const q = new URLSearchParams(long[1]);
    const t = q.get("t") ?? "";
    if (!SECRET.test(t) || q.get("k") === "phone") return refuse("not_a_code");
    return { ok: true, kind: "ticket", ticket: t, relay: q.get("r") ?? "", for: "server" };
  }
  if (isOldOffer(raw)) return refuse("old_offer");
  return refuse("not_a_code");
}

/** The sample long code the mock store shows (a made-up secret, no real relay). */
export const SAMPLE_CODE = "vyre://wink/2?t=SGVsbG9TYW1wbGVTZWNyZQ&r=wss%3A%2F%2Frelay.example";
