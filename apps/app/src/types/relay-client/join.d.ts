// What the app uses of relay/client/join.js: a typed invite code redeemed over the relay, with no box of this device's own.
export type InviteRedeem = { ok: true; link: string; space?: string } | { ok: false; reason: "format" | "busy" | "offline" | "refused" | "expired" | "not_an_invite" };
export function redeemInviteCode(o: { relay: string; input: string; onAck?: (ack: string) => void; waitMs?: number; pollMs?: number; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> }): Promise<InviteRedeem>;

/** A browser or phone with no box pairs to the person's server by the code the phone's Devices screen shows (relay/client/join.js joinWithCode). */
export type JoinResult = { ok: true; paired: { relay: string; route: string; box: string; device: string; name: string } } | { ok: false; reason: "format" | "busy" | "offline" | "refused" | "closed" | "expired" };
export function joinWithCode(o: { relay: string; input: string; name?: string; onState?: (s: { state: "ack" | "waiting" | "joining"; code?: string }) => void; pairOptions?: Record<string, unknown>; waitMs?: number; pollMs?: number }): Promise<JoinResult>;
