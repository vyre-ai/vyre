// @ts-check
// Where a test that spawns a child process or opens a listener may run. Never the person's Mac: on
// darwin only a GitHub-hosted runner counts (GITHUB_ACTIONS=true), not a CI=1 someone exported. Used by
// every test under core/watchers and lib/sandbox that starts a child, a wall probe or a listener.

export const OFF_MAC = "spawns children or opens listeners: it runs on a hosted runner, never on the person's Mac";

/**
 * The reason a test must skip here, or false when it may run.
 * @param {{ platform?: string, env?: Record<string, string | undefined> }} [o]
 * @returns {string | false}
 */
export function skipOffRunner({ platform = process.platform, env = process.env } = {}) {
  if (platform !== "darwin") return false;
  return env.GITHUB_ACTIONS === "true" ? false : OFF_MAC;
}
