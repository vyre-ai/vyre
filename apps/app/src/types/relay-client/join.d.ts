// What the app uses of relay/client/join.js: a typed invite code redeemed over the relay, with no box of this device's own.
export type InviteRedeem = { ok: true; link: string; space?: string } | { ok: false; reason: "format" | "busy" | "offline" | "refused" | "expired" | "not_an_invite" };
export function redeemInviteCode(o: { relay: string; input: string; onAck?: (ack: string) => void; waitMs?: number; pollMs?: number; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> }): Promise<InviteRedeem>;
