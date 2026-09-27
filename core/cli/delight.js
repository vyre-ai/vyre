// @ts-check
// delight: the rare, quiet things. A fortune line the title bar shows once in a long while, and
// the words `vyre high-five` prints (core/cli/commands/high-five.js, hidden from `vyre help`).
//
// Off for --json, CI, NO_COLOR, non-TTY and prefers-reduced-motion (docs/work/launch-surfaces.md,
// "Easter eggs"). No network, no sound, never on real data: every line below is invented, never
// pulled from a session, a name or a file. Pure functions only, so a test can pin the odds
// without sleeping or touching a real screen.

/** One line at a time, never a name, a project or anything a person typed. */
const FORTUNES = [
  "the thread is still here.",
  "nothing dropped while you were gone.",
  "still your box, still your key.",
  "quiet is a feature.",
  "the long way round is still the way.",
];

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

/**
 * The fortune line for the title bar, or "" most of the time. `odds` is how often it can win (1
 * in `odds`), `rand` is injectable so a test can pin it, `now` picks which fortune so the same
 * minute always shows the same line rather than flickering between repaints.
 * @param {{ json?: boolean, env?: Record<string, string|undefined>, stream?: { isTTY?: boolean },
 *   odds?: number, rand?: () => number, now?: number }} [o]
 */
export function fortune({ odds = 200, rand = Math.random, now = Date.now(), ...gate } = {}) {
  if (!allowed(gate)) return "";
  if (rand() >= 1 / odds) return "";
  const i = Math.floor(now / 60000) % FORTUNES.length;
  return FORTUNES[i];
}

/** What `vyre high-five` prints. Never the same line as the title bar's fortune, so finding the
 *  command feels like a different door, not a repeat. */
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
