// @ts-check
// release-watch: a packaged daemon that starts with no signed module list does not sit at 0 modules. After an update by an OLD updater (a 0.2.x server), the first start of the new image
// happens before that updater publishes the release's files; the module list reaches the box a moment later inside shell.json (lib/release-shell.js). So the daemon, listening already, waits for
// a list that verifies (the same check the kernel makes at boot, with the pinned release key), bounded, and then restarts itself once so every module starts on it with no manual restart.
// If nothing verifiable arrives it says so and stays: `vyre status` reads state() from /v1/health. A list that is present but does not verify is not waited for: that is a refusal, not an update in flight.

/**
 * @param {{ read: () => { ok: boolean, why?: string }, onFound: () => void, log?: (m: string) => void, pollMs?: number, waitMs?: number, now?: () => number }} o
 * @returns {{ state: () => "waiting" | "found" | "gave_up" | null, stop: () => void }}
 */
export function watchForList({ read, onFound, log = () => {}, pollMs = 2000, waitMs = 120_000, now = Date.now }) {
  const first = read();
  // A list that is there and good needs no wait; one that is there and bad is a refusal; only "not there yet" is an update that may still be arriving.
  if (first.ok || !/there is no|has no signature|no signed list|no SHA256SUMS/i.test(String(first.why))) return { state: () => null, stop() {} };
  const since = now();
  /** @type {"waiting" | "found" | "gave_up"} */ let st = "waiting";
  log("release: no signed module list yet; finishing the update (waiting for the release's files)");
  /** @type {NodeJS.Timeout | null} */ let t = null;
  const tick = () => {
    const r = read();
    if (r.ok) { st = "found"; log("release: the signed module list arrived and verifies; restarting once to start the modules"); onFound(); return; }
    if (now() - since >= waitMs) { st = "gave_up"; log("release: the signed module list never arrived; no module will start until it does (vyre update)"); return; }
    t = setTimeout(tick, pollMs); if (t.unref) t.unref();
  };
  t = setTimeout(tick, pollMs); if (t.unref) t.unref();
  return { state: () => st, stop() { if (t) clearTimeout(t); } };
}
