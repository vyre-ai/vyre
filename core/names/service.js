// @ts-check
// The names service: `<you>.vyre.run`, claimed through the name directory (ADR 0002, DESIGN-wink 2).
//
// A name is claimed, released and watched here, and nothing else: there is no listener, no certificate and no VPN. The browser address of a home is the
// built-in network's to publish (SPEC-wink-network 4.5), and "a home with no Wink node yet publishes no address": until then a claim stops at "named". Everything that
// touches the outside world comes in as an adapter (the name directory, the DNS resolver), so the whole flow runs in tests against fakes. index.js wires the real ones.

import { verdict } from "./rules.js";

/** Is this a name someone can have? Pure, so the Deck's check and the claim agree. */
export function checkName(name) {
  const v = verdict(name);
  return { name: v.name, valid: v.status === "ok", why: v.why };
}

/**
 * @param {{ ctx: any, save: (patch: any) => void,
 *   directory?: ReturnType<typeof import("./directory.js").directory>,
 *   resolver?: { resolveCname(host: string): Promise<string[]>, resolveCaa(host: string): Promise<any[]> },
 *   now?: () => number }} deps
 */
export function names(deps) {
  const { ctx } = deps;
  const net = () => ctx.config.network || {};
  const domain = () => net().domain || "vyre.run";
  /** @type {{ phase: "idle"|"named"|"failed", why: string|null }} */
  const state = { phase: "idle", why: null };
  const dir = deps.directory || null;
  let working = null;
  const fail = e => { state.phase = "failed"; state.why = /** @type {Error} */ (e).message; ctx.log("names: " + state.why); };

  function status() {
    return {
      name: ctx.config.name || null,
      address: net().address || null,
      via: net().via || null,
      phase: state.phase === "idle" && net().via === "vyre.run" && ctx.config.name ? "named" : state.phase,
      why: state.why,
      certificate: null,
      listening: false,
      port: null,
      domain: null,
    };
  }

  async function check(raw) {
    const c = checkName(raw);
    const out = { name: c.name, valid: c.valid, available: false, why: c.why, address: null };
    if (!c.valid) return out;
    if (!dir) return { ...out, why: "the name directory is not set up on this machine" };
    try {
      const r = await dir.check(c.name);
      return { ...out, available: r.status === "ok" || r.status === "mine", why: r.status === "ok" || r.status === "mine" ? null : r.why || "someone else has that name" };
    } catch (e) {
      return { ...out, why: "could not check: " + /** @type {Error} */ (e).message };
    }
  }

  /**
   * Reserve the name for this box through the directory. The address is published once the built-in
   * network has one for this home; until then the name is only held ("named").
   * @param {string} [raw]
   */
  function claim(raw) {
    const c = checkName(raw || ctx.config.name);
    if (!c.valid) throw new Error(c.why || "no name");
    if (!dir) throw new Error("claiming a name needs the name directory");
    return claimNamed(c.name);
  }

  /** @param {string} name */
  async function claimNamed(name) {
    if (working) return status();
    state.phase = "idle"; state.why = null;
    working = true;
    try {
      const r = await /** @type {NonNullable<typeof dir>} */ (dir).claim(name);
      deps.save({ name, network: { via: "vyre.run" } });
      if (r.fresh) ctx.events.emit("name.claimed", { name: `${name}.${domain()}` });
      state.phase = "named";
    } catch (e) { fail(e); } finally { working = null; }
    return status();
  }

  async function release() {
    const name = ctx.config.name;
    if (name && net().via === "vyre.run") {
      if (dir) await dir.release(name);
      ctx.events.emit("name.released", { name: `${name}.${domain()}` });
    }
    deps.save({ network: { address: null, via: null } });
    state.phase = "idle";
    return status();
  }

  let told = 0;
  /**
   * Ask the directory how this box's name stands. Run at start and hourly.
   */
  async function watch() {
    if (!dir) return null;
    // Only a box that holds a name here has anything to watch. A box that
    // never claimed one makes no request to the directory, and starts nothing (no route key made,
    // no signature, no outbound connection) just because vyred is running.
    if (net().via !== "vyre.run") return null;
    const m = await dir.mine();
    // Support moved this box's name to another server (an operator rebind): tell the person once.
    if (!m.name && m.moved && ctx.config.name === m.moved.name && told !== m.moved.at) {
      told = m.moved.at;
      ctx.events.emit("name.moved", { name: `${m.moved.name}.${domain()}`, at: m.moved.at });
    }
    return m;
  }

  /**
   * Live DNS for the two records a person adds at their own domain: `_acme-challenge.<domain>`
   * as a CNAME to `<routehash>.acme.vyre.run` (required), and an optional CAA that pins their
   * certificates to this box's own ACME account.
   * @param {string} raw
   */
  async function domainCheck(raw) {
    const host = String(raw || "").trim().toLowerCase().replace(/\.$/, "");
    if (!/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(host) || host === domain() || host.endsWith("." + domain())) throw new Error("that is not a domain of your own");
    if (!dir || !deps.resolver) throw new Error("the domain check needs the name directory");
    const m = await dir.mine();
    if (!m.name) throw new Error("claim a name first");
    const expected = m.acmeZone;
    if (!expected) throw new Error("the directory did not say where challenges go");
    const ask = async fn => { try { return await fn(); } catch (e) { const code = /** @type {any} */ (e).code; if (["ENODATA", "ENOTFOUND", "NXDOMAIN", "ENOENT"].includes(code)) return []; throw e; } };
    const challenge = `_acme-challenge.${host}`;
    const cnames = (await ask(() => deps.resolver.resolveCname(challenge))).map(x => String(x).toLowerCase().replace(/\.$/, ""));
    const caa = (await ask(() => deps.resolver.resolveCaa(host))).map(r => r.issue ?? r.issuewild ?? "").filter(Boolean).map(String);
    const account = deps.accountUri ? await deps.accountUri() : null;
    const pinned = account ? caa.some(v => v.includes("letsencrypt.org") && v.includes(`accounturi=${account}`)) : null;
    const cname = { host: challenge, expected, found: cnames, ok: cnames.includes(expected) };
    return { domain: host, ok: cname.ok, cname, caa: { host, present: caa.length > 0, found: caa, expected: account, ok: pinned, optional: true } };
  }

  return { status, check, claim, release, watch, domainCheck, wait: () => working };
}
