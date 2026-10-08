// What the app uses of relay/client/join.js: a typed invite code redeemed over the relay, with no box of this device's own.
export type InviteRedeem = { ok: true; link: string; space?: string } | { ok: false; reason: "format" | "busy" | "offline" | "refused" | "expired" | "not_an_invite" };
export function redeemInviteCode(o: { relay: string; input: string; onAck?: (ack: string, expires?: number) => void; waitMs?: number; pollMs?: number; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> }): Promise<InviteRedeem>;

/** A browser or phone with no box pairs to the person's server by the code the phone's Devices screen shows (relay/client/join.js joinWithCode). `server` is who will own a server being paired (its proof is made by signIdentity). */
export type JoinResult = { ok: true; paired: { relay: string; route: string; box: string; device: string; name: string }; done?: unknown }
  | { ok: false; reason: "format" | "busy" | "offline" | "refused" | "closed" | "expired" | "needs_identity"; code?: string; message?: string };
export type JoinServer = { owner: { id: string; name?: string; vyre?: string; pin?: { id: string; seq: number; head: string } }; signIdentity?: (m: Uint8Array) => Promise<{ eid: string; sig: string; esig?: string }> | { eid: string; sig: string; esig?: string };
  deviceKind?: "phone" | "computer" | "web"; keyStorage?: "hardware" | "software"; crypto?: unknown; keyStore?: unknown; onWords?: (w: string) => void };
export function joinWithCode(o: { relay: string; input: string; name?: string; onState?: (s: { state: "ack" | "waiting" | "joining"; code?: string; expires?: number }) => void; pairOptions?: Record<string, unknown>; waitMs?: number; pollMs?: number;
  server?: JoinServer; entry?: unknown; onWords?: (w: string) => void; signal?: AbortSignal; finishPollMs?: number; finishTimeoutMs?: number }): Promise<JoinResult>;
