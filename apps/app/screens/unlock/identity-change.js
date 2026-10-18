// @ts-check
// When the identity on this device changes state, what the app decrypted for the previous state must not stay searchable: the on-device message index (src/chat/message-index.js) is cleared.
// Pure, so Node tests it.

/** @typedef {{ exists?: boolean, unlocked?: boolean, username?: string | null, unreachable?: boolean } | null} Status */

/**
 * Whether the move from one identity status to the next ends the previous session: the identity is now locked or gone, or a different person's. A first read (no previous status) and an
 * unreachable box change nothing: the app has not lost its session, it just cannot tell.
 * @param {Status} prev @param {Status} next
 */
export function endsSession(prev, next) {
  if (!next || next.unreachable) return false;
  if (!prev) return false;
  const was = Boolean(prev.exists && prev.unlocked);
  const now = Boolean(next.exists && next.unlocked);
  if (was && !now) return true;
  if (was && now && prev.username && next.username && prev.username !== next.username) return true;
  return false;
}
