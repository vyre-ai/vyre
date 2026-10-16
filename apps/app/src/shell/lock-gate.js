// @ts-check
// The lock gate. Coming back to the app, an identity that is made but not unlocked on this device needs its master password before anything else draws; a legacy identity that
// has no master password yet is asked for one. After a quiet spell the app locks itself again. Pure, so Node tests it; src/shell/UnlockGate.tsx reads identity.status and calls this.

/** The auto-lock choices, in minutes, as the Settings control lists them. "0" is Never. */
export const LOCK_CHOICES = Object.freeze([["5", "5 minutes"], ["15", "15 minutes"], ["60", "1 hour"], ["0", "Never"]]);
export const DEFAULT_LOCK_MINUTES = 15;

/** The minutes a stored setting means; anything that is not one of the choices is the default. @param {unknown} raw */
export function lockMinutes(raw) {
  const text = String(raw ?? "").trim();
  return LOCK_CHOICES.some(([v]) => v === text) ? Number(text) : DEFAULT_LOCK_MINUTES;
}

/**
 * What the gate shows for what identity.status answered: "unlock" (made, locked), "migrate" (keys with no master password), or "none" (nothing to ask, or nothing known).
 * @param {{ exists?: boolean, unlocked?: boolean, needsMigration?: boolean } | null | undefined} status
 * @returns {"none" | "unlock" | "migrate"}
 */
export function lockView(status) {
  if (!status || typeof status !== "object") return "none";
  if (status.needsMigration === true) return "migrate";
  if (status.exists === true && status.unlocked !== true) return "unlock";
  return "none";
}

/** Is the auto-lock timer wanted: an identity that is unlocked, and a setting that is not Never. @param {{ exists?: boolean, unlocked?: boolean } | null | undefined} status @param {number} minutes */
export function lockWanted(status, minutes) {
  return Boolean(status && status.exists === true && status.unlocked === true && minutes > 0);
}

/**
 * The tool input for the person's answer. A recovery key is a different field from a password; the screen never sends both.
 * @param {{ mode: "password" | "recovery", text: string }} a
 * @returns {{ password: string } | { recovery: string }}
 */
export function unlockInput({ mode, text }) {
  return mode === "recovery" ? { recovery: String(text).trim() } : { password: String(text) };
}

/** The words for a refusal from identity.unlock, identity.migrate or the tool that carries them. @param {unknown} code @param {string} [message] */
export function unlockRefusal(code, message = "") {
  if (code === "bad_password") return "That is not your master password. Try again, or use your recovery key.";
  if (code === "bad_recovery") return "That recovery key does not unlock this identity. Check it and type it again.";
  if (code === "no_identity") return "There is no identity on this device yet.";
  if (code === "offline") return "Vyre is not answering on this device. Wait a moment and try again.";
  return message || "That did not work. Try again.";
}

/**
 * One idle timer. `touch()` notes activity (cheap: it only records the time); the timer wakes when the quiet spell could have ended, and locks if it has. `stop()` clears it.
 * The clock and the timer are given, so a test drives them without waiting.
 * @param {{ minutes: number, onIdle: () => void, now?: () => number, setTimer?: (f: () => void, ms: number) => unknown, clearTimer?: (t: any) => void }} o
 */
export function createIdleLock(o) {
  const now = o.now || Date.now;
  const set = o.setTimer || ((f, ms) => setTimeout(f, ms));
  const clear = o.clearTimer || ((t) => clearTimeout(t));
  let ms = o.minutes * 60_000;
  let last = now();
  /** @type {unknown} */ let timer = null;
  let running = false;
  const arm = (/** @type {number} */ wait) => { timer = set(wake, Math.max(1000, wait)); };
  function wake() {
    timer = null;
    if (!running) return;
    const quiet = now() - last;
    if (quiet >= ms) { running = false; o.onIdle(); return; }
    arm(ms - quiet);
  }
  return {
    start() { if (running || !(ms > 0)) return; running = true; last = now(); arm(ms); },
    touch() { last = now(); },
    stop() { running = false; if (timer !== null) { clear(timer); timer = null; } },
    /** @param {number} minutes */
    setMinutes(minutes) { ms = minutes * 60_000; if (running) { if (timer !== null) clear(timer); timer = null; if (ms > 0) arm(Math.max(0, ms - (now() - last))); else running = false; } },
    get running() { return running; },
  };
}
