// @ts-check
// identity/login-start: turns the sign-in service (kernel/identity/space-login.js) on for a server. It listens on loopback and tells the public gate its port (lib/login-door.js).
// A computer that is not a server has no space address to sign in to, so nothing listens there. Records live in identity/logins.json, 0600.

import { hostedOrigins, isServer } from "../config/index.js";
import { createLoginStore } from "./login-store.js";
import { createLoginService } from "../../kernel/identity/space-login.js";
import { idDirectory, memorySeen } from "../../lib/identity/directory.js";
import { assertPublishedKey } from "../../lib/identity/published-key.js";
import { setLoginPort } from "../../lib/login-door.js";
import { RELAY_ASSERT_KEY } from "../../lib/relay-keys.js";
import { listen } from "./login-listener.js";

/** One tool-free HTTP door: begin, finish, register. @param {{ op?: string } & Record<string, any>} q @param {ReturnType<typeof createLoginService>} svc @param {string} source */
export async function loginHandle(q, svc, source) {
  const op = String(q && q.op || "");
  if (op === "begin") { const r = svc.begin(/** @type {any} */ (q), source); return { status: r.error ? (r.error.code === "rate_limited" ? 429 : 400) : 200, body: r }; }
  if (op === "finish") { const r = await svc.finish(/** @type {any} */ (q), source); return { status: r.error ? (r.error.code === "rate_limited" ? 429 : 401) : 200, body: r }; }
  if (op === "register") {
    try { return { status: 200, body: await svc.register(/** @type {any} */ (q)) }; }
    catch (e) { const err = /** @type {any} */ (e); return { status: err.code === "denied" ? 403 : 400, body: { error: { code: String(err.code || "bad_input"), message: String(err.message || "That did not work.") } } }; }
  }
  if (op === "github") { const r = await svc.githubFinish(/** @type {any} */ (q), source); return { status: r.error ? (r.error.code === "rate_limited" ? 429 : 401) : 200, body: r }; }
  if (op === "link-github") {
    try { return { status: 200, body: await svc.linkGithub(/** @type {any} */ (q)) }; }
    catch (e) { const err = /** @type {any} */ (e); return { status: err.code === "denied" ? 403 : 400, body: { error: { code: String(err.code || "bad_input"), message: String(err.message || "That did not work.") } } }; }
  }
  return { status: 400, body: { error: { code: "bad_input", message: "That request was not understood." } } };
}

/** @param {any} ctx @param {{ listen?: typeof listen, directory?: { resolveById: (id: string) => Promise<any> } }} [seam] */
export async function startLogin(ctx, seam = {}) {
  const cfg = ctx.config || {};
  if (!isServer(cfg.machine) || typeof cfg.name !== "string" || !cfg.name) return { async stop() {} };
  const store = createLoginStore(ctx.paths.root);
  const rawDir = cfg.names && cfg.names.directory;
  const dir = seam.directory || idDirectory({ ...(typeof rawDir === "string" && /^https?:\/\//.test(rawDir) ? { base: rawDir } : {}), seen: memorySeen() });
  const roleOf = async (/** @type {string} */ person) => {
    const k = ctx.kernel;
    if (!k) return "member";
    if (typeof k.owner === "string" && k.owner === person) return "owner";
    try { const m = await k.membership(person, k.space); return m && typeof m.role === "string" ? m.role : "member"; } catch { return "member"; }
  };
  const svc = createLoginService({
    describe: async (_username, rec) => { const role = await roleOf(String(rec.person)); return { role, spaces: [{ id: String((ctx.kernel && ctx.kernel.space) || ""), name: String(cfg.name), role, server: `https://${cfg.name}.vyre.run` }] }; },
    space: String(cfg.name), store, relayPub: cfg.github && typeof cfg.github.assertKey === "string" && cfg.github.assertKey ? cfg.github.assertKey : RELAY_ASSERT_KEY,
    verifyIdentity: async (person, pub) => { try { await assertPublishedKey(dir, person, pub, { fullDevice: true }); return true; } catch { return false; } },
    isMember: async (_username, person) => {
      const k = ctx.kernel;
      if (!k || typeof k.membership !== "function") return false;
      if (typeof k.owner === "string" && k.owner === person) return true;
      try { const m = await k.membership(person, k.space); return Boolean(m && m.member === true); } catch { return false; }
    },
    onNewDevice: e => { try { ctx.events.emit("signin.new-device", { device: e.device, at: e.at }); } catch { /* the notice is best effort; the sign-in is not blocked */ } },
  });
  const l = await (seam.listen || listen)({ origins: () => hostedOrigins(cfg.network), handle: (q, source) => loginHandle(q, svc, source) });
  setLoginPort(l.port);
  ctx.log && ctx.log(`identity: POST /login listening on ${l.url}`);
  return { async stop() { setLoginPort(null); await l.close(); } };
}
