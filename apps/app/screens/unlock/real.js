// @ts-check
// The only door the lock screens use. Every name is a registry tool (core/identity), which the MCP server forwards as itself; a model cannot supply the password or the key.
import { tool } from "../../src/real/box";
import { statusFailure, unlockRefusal } from "../../src/shell/lock-gate.js";

/** @param {any} e */
const fail = (e) => ({ ok: false, message: unlockRefusal(e && e.code ? String(e.code) : "failed", (e && e.message) || ""), code: e && e.code ? String(e.code) : "failed" });
/** @param {unknown} value @returns {any} */
const done = (value) => ({ ok: true, ...(value && typeof value === "object" ? value : {}) });

/** What this device holds: { exists, unlocked, needsMigration, username }. Null for a build with no identity tool; { unreachable: true } when the read failed (the lock then stays on and says so). */
export async function identityState() {
  try { return /** @type {any} */ (await tool("identity.status", {})); }
  catch (e) { return statusFailure(e); }
}

/** @param {{ password: string } | { recovery: string }} input */
export async function unlockIdentity(input) {
  try {
    const r = await tool("identity.unlock", input);
    // The vault takes the unlocked key at once, so what the password opened is usable and nothing waits on a second step. A build with no vault has nothing to take it (no_such_tool).
    await tool("identity.vault.install", {}).catch((e) => { if (!e || (e.code !== "no_such_tool" && e.code !== "not_found")) throw e; });
    return done(r);
  } catch (e) { return fail(e); }
}

/** @param {string} password */
export async function migrateIdentity(password) {
  try { return done(await tool("identity.migrate", { password })); }
  catch (e) { return fail(e); }
}

export async function lockIdentity() {
  try { return done(await tool("identity.lock", {})); }
  catch (e) { return fail(e); }
}
