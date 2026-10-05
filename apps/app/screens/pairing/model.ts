// The pure half of the pairing card on Now (the Deck's pair.js, ported): a Mac asking to pair, the code the person types, and the words for what the box answers.
// The box never lists a request's code (core/link/box.js): it is on the Mac's screen, so the person types it here.

export type PairRequest = { id: string; name: string; sub: string; expires: number };

/** link.pending: one row per waiting request, oldest first. Anything that is not a row is dropped. */
export function requestsOf(data: unknown): PairRequest[] {
  const list: unknown[] = Array.isArray(data) ? data : [];
  return list
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && typeof (x as Record<string, unknown>).id === "string")
    .map((p) => ({
      id: String(p.id),
      name: String(p.name || "A computer"),
      sub: [p.node, p.login].filter(Boolean).join(" · "),
      expires: Number(p.expires) || 0,
    }))
    .sort((a, b) => a.expires - b.expires);
}

export const digits = (s: string): string => String(s).replace(/\D/g, "").slice(0, 6);
/** "123456" as "123-456", as the person types it. */
export const shape = (s: string): string => { const d = digits(s); return d.length > 3 ? `${d.slice(0, 3)}-${d.slice(3)}` : d; };
export const canApprove = (code: string): boolean => digits(code).length === 6;

/** Whole minutes left, never below 0. */
export const minutesLeft = (expires: number, now: number): number => Math.max(0, Math.ceil((expires - now) / 60_000));
export const leftLine = (expires: number, now: number): string => { const m = minutesLeft(expires, now); return m > 0 ? `${m} min left` : "Expired"; };
export const live = (r: PairRequest, now: number): boolean => r.expires > now;

/** What the card shows: the requests still good, the ones that ran out dropped, so the card is gone when none are left. */
export const visible = (rs: PairRequest[], now: number, done: ReadonlySet<string> = new Set()): PairRequest[] => rs.filter((r) => live(r, now) && !done.has(r.id));

export const EXPIRED = "This request ran out of time. Start pairing again on the computer.";
export const APPROVING = "Waiting for your approval.";

/** The box's refusals in words that say what to do next. */
export function pairSay(e: { code?: string; message?: string } | undefined): string {
  const m = String(e?.message || "");
  if (/cannot approve its own|approve with your passkey/.test(m)) return "The computer that is asking cannot approve itself without a passkey. Approve with Face ID or fingerprint on this device.";
  if (/no pairing request has that code/.test(m)) return "That code does not match. Check the code on the computer and try again.";
  if (/too many wrong codes/.test(m)) return "Too many wrong codes, so every request was cancelled. Start again on the computer.";
  if (/too many pairing requests/.test(m)) return "Too many requests are waiting. Approve or deny the ones on screen first.";
  if (e?.code === "cancelled") return "Cancelled. Nothing was paired.";
  if (e?.code === "no_passkey" || e?.code === "presence_required") return `${m || "Approving needs your passkey."} Set one up in Settings, Security.`;
  return m || "The request could not be answered.";
}

export const pairedLine = (name: string): string => `${name} is paired. Its sessions and files show up here in a minute.`;
export const deniedLine = (name: string): string => `Refused. ${name} was told no.`;

/** "A new device is asking" from wink.phone.pairing. Same shape the Devices screen reads. */
export function winkAsking(r: unknown): { name: string; words: [string, string, string] } | null {
  const x = r as { asking?: boolean; name?: unknown; words?: unknown } | null;
  if (!x || !x.asking) return null;
  const a = Array.isArray(x.words) ? x.words.map(String) : typeof x.words === "string" ? x.words.trim().split(/\s+/) : [];
  if (a.length !== 3 || !a.every(Boolean)) return null;
  return { name: String(x.name || "A new device"), words: a.map((w) => w.toLowerCase()) as [string, string, string] };
}

/** Events that mean the list changed. */
export const PAIR_EVENTS = /^(link\.pair-requested|link\.paired|wink\.)/;
