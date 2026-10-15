// @ts-check
// Forgetting this computer's identity in the Mac app lets go of every server it reaches, together: the shell's own alert names those servers first ("This Mac will no longer reach testbox"), and only
// after the person's yes does anything go. The shell then drops the identity key and the relay key every pairing used (local/capsule/native/Sources/Host/ForgetMac.swift), and the page forgets its
// pairings and everything else it held (the same wipe as a removed device), then starts again at the pair-again screen. A no changes nothing. Pure, so Node tests it.

/** The server names the alert shows, from this device's pairings: each once, in the order they were added; a pairing with no name is "a server". @param {{ name?: string }[]} pairings */
export const serverNamesOf = pairings => [...new Set(pairings.map(p => String((p && p.name) || "").trim() || "a server"))];

/**
 * @param {{ forget: (servers: string[]) => Promise<void>, pairings: () => Promise<{ name?: string }[]>, wipe: () => Promise<unknown>, after: () => void }} d
 *   forget: the shell's identity.forget (its alert, then both keys; rejects on a no). wipe: the device wipe. after: the pair-again screen.
 * @returns {Promise<{ servers: string[] }>} the servers this computer no longer reaches
 */
export async function forgetThisMac(d) {
  const servers = serverNamesOf(await d.pairings().catch(() => []));
  await d.forget(servers);
  await d.wipe();
  d.after();
  return { servers };
}
