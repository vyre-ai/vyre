// @ts-check
// Forgetting this computer's identity in the Mac app lets go of every server it reaches, together: the shell's own alert names those servers first ("This Mac will no longer reach testbox"), and only
// after the person's yes does anything go. The shell drops the identity key (local/capsule/native/Sources/Host/ForgetMac.swift) and keeps the relay key a moment longer: over it, this Mac takes itself
// off each server (relay.devices.leave, its own row only), so no server keeps a stale row. Then the relay key goes, and the page forgets its pairings and everything else it held (the same wipe as a
// removed device), then starts again at the pair-again screen. A no changes nothing. A server that could not be reached keeps its row for its owner to remove, and the answer names it. Pure, so Node tests it.

/** The server names the alert shows, from this device's pairings: each once, in the order they were added; a pairing with no name is "a server". @param {{ name?: string }[]} pairings */
export const serverNamesOf = pairings => [...new Set(pairings.map(p => String((p && p.name) || "").trim() || "a server"))];

/**
 * @typedef {{ box: string, name?: string }} Paired
 * @param {{ forget: (servers: string[]) => Promise<void>, pairings: () => Promise<Paired[]>, leave: (p: Paired) => Promise<unknown>, dropRelay: () => Promise<void>, wipe: () => Promise<unknown>, after: () => void }} d
 *   forget: the shell's identity.forget with keepRelay (its alert, then the identity key; rejects on a no). leave: relay.devices.leave on that server. dropRelay: the shell's relayKey.forget.
 *   wipe: the device wipe. after: the pair-again screen.
 * @returns {Promise<{ servers: string[], kept: string[] }>} the servers this computer no longer reaches, and those that could not be told (each keeps a row for its owner to remove)
 */
export async function forgetThisMac(d) {
  const paired = await d.pairings().catch(() => []);
  const servers = serverNamesOf(paired);
  await d.forget(servers);
  /** @type {string[]} */ const kept = [];
  for (const p of paired) { try { await d.leave(p); } catch { kept.push(String(p.name || "").trim() || "a server"); } }
  await d.dropRelay().catch(() => {});
  await d.wipe();
  d.after();
  return { servers, kept: [...new Set(kept)] };
}
