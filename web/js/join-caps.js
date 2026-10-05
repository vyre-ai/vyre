// @ts-check
// Whether this device can use "pair with a code" (relay.join): server-decided, per the lead
// (28 Sep) — anywhere is adding `onboard.status.can.relayJoin` (false on a Mac until vyre-core,
// with a plain reason), and tailnet's relay.join itself refuses on darwin as a backstop. Not
// shipped yet in this worktree's core/onboard/index.js; this module is launch's client-side
// reading of that shape, ready to switch on the moment it lands. A missing field (an older
// server, or before it ships) is treated as false, never true — never offer a path that might
// not work.

/**
 * @param {{ can?: { relayJoin?: boolean, relayJoinReason?: string } } | null | undefined} status
 * @returns {{ allowed: boolean, reason: string|null }}
 */
export function canRelayJoin(status) {
  const allowed = status?.can?.relayJoin === true;
  return { allowed, reason: allowed ? null : (status?.can?.relayJoinReason || null) };
}
