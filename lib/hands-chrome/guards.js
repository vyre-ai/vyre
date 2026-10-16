// @ts-check
// Grant and plan guards shared by box hands-chrome and Mac hands-chrome-mac.

/** @param {string} code @param {string} message */
export const denied = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });

/**
 * The one grant lives in the hands module when it is present: an agent granted to drive the
 * computer may drive its Chrome. On a box without hands, every agent with a computer is allowed.
 * @param {string} agent
 * @param {(tool: string, input?: any) => Promise<any>} call
 */
export async function requireGrant(agent, call) {
  if (!agent) return;
  const r = await call("hands.grant.list", {}).catch(() => ({ error: { code: "no_such_tool" } }));
  if (r && r.error && r.error.code === "no_such_tool") return;
  const ok = r && !r.error && Array.isArray(r.data) && r.data.some((/** @type {any} */ g) => g.agent === agent);
  if (!ok) {
    throw denied("denied", String(agent).startsWith("caller:")
      ? "This assistant has no permission to use this computer yet. Add it in Access. (not granted)"
      : `${agent} is not granted to drive this computer. Grant it once with hands.grant.add or ask the person to.`);
  }
}
