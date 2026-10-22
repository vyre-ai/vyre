// @ts-check
// How many invitee channels may be open: a small pool for everyone, and a smaller cap for one invitation, so one invitation cannot hold every slot.

/** One invitation may hold this many channels open. */
export const INVITEE_PER = 2;
/** Every invitation together may hold this many channels open. */
export const INVITEE_POOL = 8;

/**
 * Whether another invitee channel may open.
 * @param {{ pool: number, forInvite: number, poolMax?: number, perMax?: number }} s
 */
export function inviteeMayOpen(s) {
  const poolMax = s.poolMax ?? INVITEE_POOL;
  const perMax = s.perMax ?? INVITEE_PER;
  return s.pool < poolMax && s.forInvite < perMax;
}
