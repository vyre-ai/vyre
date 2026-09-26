// @ts-check
// prove: interim presence for the vault's value tools, until ADR 0004's registry merges.
//
// SPEC 11 floor rule 8: a value may be shown to a person who has just proved presence on their
// own device, for that one value. Until the registry checks presence itself, every tool that
// returns or moves a value asks `proof.prove` first. The registry marks a call it already
// checked (`ctx.presenceEnforced === true`, or `presence` in run's second argument), and then
// nothing is asked twice. `proof.prove` is the one swappable function: security replaces it.
//
// How a person proves it, by caller:
//   - cli, local, capsule on a Mac: Touch ID or the Mac's password through the enclave helper's
//     `auth` verb, with the tool's summary as the reason. One dialog at a time, and 30 seconds
//     of refusals after a cancel, so a loop cannot pop dialogs until someone clicks yes.
//   - deck: `confirm: true` in the input, and, when the daemon tells us who is on the other end
//     of a tailnet request (`peer.login`), that login must be the owner (config vault.owner or
//     login). This branch's daemon passes no peer: the Deck reaches vyred through the local
//     socket only, so the proof is the confirm alone. That is weaker than Touch ID, and it is
//     stated here rather than hidden.
//   - anything else, and any machine without Touch ID (Linux, a box): refused, in words.
//   - under node --test: `vault.testHelpers.prove` decides ("allow" by default, "deny", or
//     `{ mode, record }` to record the summaries a person would have read). No test ever shows
//     a dialog.

import fs from "node:fs";
import { callerKind } from "../modules/index.js";
import { enclaveCall } from "./touchid.js";

/** Tools that return or move a value. */
export const PROVE_TOOLS = new Set([
  "vault.reveal", "vault.copy", "vault.totp", "vault.resolve", "vault.render", "vault.inject", "vault.git",
  "vault.fill.native", "vault.session.open", "vault.device.code", "vault.device.unlock", "vault.backup", "vault.export",
]);
/** An open session for the item covers these. */
const SESSION_SKIP = new Set(["vault.reveal", "vault.copy", "vault.totp"]);
export const COOLDOWN_MS = 30_000;

export const presenceRequired = message => Object.assign(new Error(message), { code: "presence_required" });

/**
 * @typedef {{ enclave: any, platform: string, config: any, peer?: { login?: string|null } | null,
 *   test: null | { mode: "allow"|"deny", record?: string }, state: { chain: Promise<any>, cooldownUntil: number }, now: () => number }} Env
 */

/**
 * The default proof. Resolves when a person proved presence for this one call, or throws an
 * Error with code "presence_required".
 * @param {{ tool: string, input: any, caller: string, summary: string, env: Env }} req
 */
async function defaultProve({ tool, input, caller, summary, env }) {
  if (env.test) {
    if (env.test.record) fs.appendFileSync(env.test.record, JSON.stringify({ tool, caller, summary }) + "\n");
    if (env.test.mode === "deny") throw presenceRequired("presence was not proved (test)");
    return;
  }
  const k = callerKind(caller);
  if (k === "deck") {
    if (!input || input.confirm !== true) throw presenceRequired(`confirm on the Deck: ${summary}`);
    const owner = env.config && env.config.vault && env.config.vault.owner || env.config && env.config.login;
    if (env.peer && env.peer.login !== undefined) {
      if (!owner || String(env.peer.login || "").toLowerCase() !== String(owner).toLowerCase()) throw presenceRequired("only the owner of this Vyre may do that from the Deck");
    }
    return;
  }
  if (!["cli", "local", "capsule"].includes(k)) throw presenceRequired(`${k} callers cannot prove presence for a value`);
  if (env.platform !== "darwin" || !env.enclave) {
    throw presenceRequired("this machine has no Touch ID, so the vault cannot ask you for presence here · use your Mac, or the Deck with confirm");
  }
  if (env.now() < env.state.cooldownUntil) throw presenceRequired("you just declined; wait 30 seconds before asking again");
  // One dialog at a time: each request waits for the one before it.
  const run = env.state.chain.then(() => enclaveCall(env.enclave, { op: "auth", reason: String(summary).slice(0, 200) }));
  env.state.chain = run.catch(() => {});
  let r;
  try { r = await run; } catch { throw presenceRequired("the presence helper did not answer"); }
  if (!r || !r.ok) {
    env.state.cooldownUntil = env.now() + COOLDOWN_MS;
    throw presenceRequired("presence was not confirmed");
  }
}

/** The swappable proof. Replace `proof.prove` to change how presence is proved. */
export const proof = { prove: defaultProve };

/** What a test config asks for, honoured only under node --test. */
function testMode(config) {
  if (!process.env.NODE_TEST_CONTEXT) return null;
  const h = config && config.vault && config.vault.testHelpers && config.vault.testHelpers.prove;
  if (h === "deny") return { mode: "deny" };
  if (h && typeof h === "object") return { mode: h.mode === "deny" ? "deny" : "allow", ...(h.record ? { record: String(h.record) } : {}) };
  return { mode: "allow" };
}

/**
 * Wrap tool definitions so every PROVE_TOOLS run asks for presence first, unless the registry
 * already checked, a module is the caller, or an open session covers the item.
 * @param {{ ctx: any, vault: any, platform?: string, now?: () => number }} o
 * @returns {(name: string, def: any) => any}
 */
export function gate({ ctx, vault, platform = process.platform, now = Date.now }) {
  const state = { chain: Promise.resolve(), cooldownUntil: 0 };
  return (name, def) => {
    if (!PROVE_TOOLS.has(name) || !def || typeof def.run !== "function") return def;
    const run = def.run;
    const input = def.input && def.input.properties ? { ...def.input, properties: { ...def.input.properties, confirm: { type: "boolean" } } } : def.input;
    return {
      ...def, input,
      run: async (inp, opts = {}) => {
        const i = inp || {};
        const caller = opts.caller;
        const proven = ctx.presenceEnforced === true || Boolean(opts.presence);
        const skip = proven || callerKind(caller) === "module"
          || (SESSION_SKIP.has(name) && Boolean(vault.sessions && vault.sessions.ok(i.session, i.name)))
          || (name === "vault.git" && i.action !== "get");
        if (!skip) {
          let summary = name;
          try { if (def.presence && typeof def.presence.summary === "function") summary = (await def.presence.summary(i)) || name; } catch {}
          try {
            await proof.prove({ tool: name, input: i, caller, summary,
              env: { enclave: vault.enclave, platform, config: ctx.config || {}, peer: opts.peer || null, test: testMode(ctx.config), state, now } });
          } catch (e) {
            vault.audit("presence", i.name ?? null, caller, false, `${name}: ${/** @type {Error} */ (e).message}`.slice(0, 200));
            throw e;
          }
        }
        return run(i, opts);
      },
    };
  };
}
