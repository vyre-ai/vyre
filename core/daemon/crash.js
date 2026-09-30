// @ts-check
// A vyred that hits an error nothing caught is in a state nobody chose. It logs the stack, gives
// the log a moment to flush, and exits non-zero, so the supervisor (launchd, systemd, the
// container's restart policy) starts a clean one. It never swallows the error.

/**
 * @param {{ log?: (s: string) => void, exit?: (code: number) => void, flushMs?: number, proc?: NodeJS.Process }} [o]
 * @returns {() => void} removes the handlers (tests)
 */
export function installCrashHandler({ log = s => process.stderr.write(s), exit = c => process.exit(c), flushMs = 200, proc = process } = {}) {
  let dying = false;
  /** @param {string} kind @param {any} err */
  const die = (kind, err) => {
    if (dying) return;
    dying = true;
    let text;
    try { text = err && err.stack ? String(err.stack) : String(err); } catch { text = "an error that cannot be printed"; }
    try { log(`vyred: ${kind}: ${text}\n`); } catch {}
    setTimeout(() => exit(70), flushMs);
  };
  const onUncaught = (/** @type {any} */ e) => die("uncaughtException", e);
  const onRejected = (/** @type {any} */ e) => die("unhandledRejection", e);
  proc.on("uncaughtException", onUncaught);
  proc.on("unhandledRejection", onRejected);
  return () => { proc.off("uncaughtException", onUncaught); proc.off("unhandledRejection", onRejected); };
}
