// @ts-check
// delight: the one hidden easter egg. The words `vyre high-five` prints (core/cli/commands/high-five.js, hidden from `vyre help`).
//
// Off for --json, CI, NO_COLOR, non-TTY and prefers-reduced-motion (docs/work/launch-surfaces.md,
// "Easter eggs"). No network, no sound, never on real data: every line below is invented, never
// pulled from a session, a name or a file. Pure functions only, so a test can pin the odds
// without sleeping or touching a real screen.

/**
 * Whether any delight is allowed to show at all, given the environment a caller passes in. The
 * caller supplies its own `env`/`stream` rather than this file reading `process` directly, so a
 * test never has to mutate the real process to check the gate.
 * @param {{ json?: boolean, env?: Record<string, string|undefined>, stream?: { isTTY?: boolean } }} [o]
 */
export function allowed({ json = false, env = process.env, stream = process.stdout } = {}) {
  if (json) return false;
  if (env.CI) return false;
  if (env.NO_COLOR) return false;
  if (env.VYRE_REDUCED_MOTION || env.PREFERS_REDUCED_MOTION) return false;
  if (!stream || !stream.isTTY) return false;
  return true;
}

/** What `vyre high-five` prints. It only answers when someone types it on purpose. */
const HIGH_FIVES = [
  "right back at you.",
  "nice one.",
  "that's the whole command.",
  "took you a while to type that.",
];

/**
 * @param {{ env?: Record<string, string|undefined>, stream?: { isTTY?: boolean }, rand?: () => number }} [o]
 */
export function highFiveLine({ env = process.env, stream = process.stdout, rand = Math.random } = {}) {
  if (!allowed({ env, stream })) return "\\o/";
  return HIGH_FIVES[Math.floor(rand() * HIGH_FIVES.length)];
}
