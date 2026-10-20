// @ts-check
// The shell's kept copy (stale while revalidate, like the Chat list): the Spaces for the switcher, the person's line and the Space that was showing, kept on this device so the app opens on its
// own screen at once and the box's answer replaces it in place. Pure: UiShell.tsx reads and writes it through the view cache.

export const SHELL_KEY = "shell.data";
/** A kept copy older than this is not shown. */
export const MAX_AGE_MS = 30 * 24 * 60 * 60_000;
/** How long the "who is signed in" check may take before the shell stops waiting on it. */
export const GATE_BUDGET_MS = 4000;

/** @param {{ me: any, spaces: any[] }} data @param {string} space @param {() => number} [clock] */
export const packShell = (data, space, clock = Date.now) => ({ v: 1, at: clock(), space, data: { me: data.me, spaces: data.spaces } });

/** @param {any} raw @param {() => number} [clock] @returns {{ data: { me: any, spaces: any[] }, space: string } | null} */
export function unpackShell(raw, clock = Date.now) {
  if (!raw || typeof raw !== "object" || raw.v !== 1 || !Number.isFinite(raw.at) || clock() - raw.at > MAX_AGE_MS) return null;
  const d = raw.data;
  if (!d || typeof d !== "object" || !d.me || typeof d.me !== "object" || !Array.isArray(d.spaces) || !d.spaces.length) return null;
  if (!d.spaces.every((/** @type {any} */ s) => s && typeof s.id === "string" && s.id)) return null;
  return { data: { me: d.me, spaces: d.spaces }, space: typeof raw.space === "string" ? raw.space : "" };
}
