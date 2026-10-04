// @ts-check
// funnel: the public share path, /s/, on Tailscale Funnel (plans/tailnet.md 3.7b, ADR 0014
// amendment of 30 Sep 2026).
//
// The artifacts module's share server listens on 127.0.0.1 and serves GET and HEAD /s/<token>
// only. When the person turns public links on or off in Settings, artifacts emits
// `artifact-links.changed { on, port, path: "/s/" }`. This subscriber then runs `tailscale funnel`
// for that one path on port 8443, or turns exactly that path off, and tells artifacts the public
// base (`artifacts.public.set { base }`) so a link carries its full URL.
//
// It touches nothing else. Hooks share 8443 with /hooks/<name>, so it always names the path
// (--set-path) and never `funnel reset` or an off with no path. It is idempotent: it reads what
// Funnel serves first and runs a change only when the path is not already as wanted. The first
// time can need Tailscale's consent (the funnel node attribute, HTTPS certificates): the CLI
// prints a link, which shows as state "needs-consent" until the person has followed it. Nothing
// polls: the state is re-checked when it is read, or when the toggle changes (SPEC principle 8).

import * as config from "../config/index.js";
import { run as tsRun } from "../names/tailscale.js";

export const FUNNEL_PORT = 8443;
export const SHARE_PATH = "/s/";
/** The most often a read of the state retries a run that waited on consent. */
const RETRY_MS = 5000;
const CLI_TIMEOUT = 20_000;

/**
 * @typedef {{ code: number, out: string, err: string }} Ran
 * @typedef {{ state: "off"|"on"|"needs-consent"|"error", wanted: boolean, port: number|null, base: string|null,
 *   consentUrl: string|null, why: string|null, since: number }} FunnelState
 */

const trimSlash = (/** @type {any} */ s) => String(s || "").replace(/\/+$/, "");

/**
 * Pure: what `tailscale funnel status --json` (a serve config) says about /s/ on 8443.
 * @param {any} cfg
 * @returns {{ served: boolean, target: string|null, funnel: boolean }}
 */
export function parseShare(cfg) {
  let found = { served: false, target: /** @type {string|null} */ (null), funnel: false };
  const walk = (/** @type {any} */ c) => {
    if (!c || typeof c !== "object") return;
    const allow = c.AllowFunnel && typeof c.AllowFunnel === "object" ? c.AllowFunnel : {};
    for (const [hostPort, web] of Object.entries(c.Web && typeof c.Web === "object" ? c.Web : {})) {
      if (!hostPort.endsWith(`:${FUNNEL_PORT}`)) continue;
      const handlers = web && /** @type {any} */ (web).Handlers && typeof (/** @type {any} */ (web).Handlers) === "object" ? /** @type {any} */ (web).Handlers : {};
      const h = handlers[SHARE_PATH] || handlers[SHARE_PATH.replace(/\/$/, "")];
      if (h) found = { served: true, target: h.Proxy ? String(h.Proxy) : null, funnel: allow[hostPort] === true };
    }
    for (const f of Object.values(c.Foreground && typeof c.Foreground === "object" ? c.Foreground : {})) walk(f);
  };
  walk(cfg);
  return found;
}

/**
 * Pure: the consent link in what the CLI printed, or null. Funnel and HTTPS both say
 * "... is not enabled on your tailnet. To enable, visit: <url>".
 * @param {string} text
 */
export function consentUrl(text) {
  const t = String(text || "");
  if (!/not enabled|to enable|enable (it|funnel|https)/i.test(t)) return null;
  // Only a Tailscale address is ever shown as a click target.
  for (const m of t.matchAll(/https:\/\/[^\s"'<>]+/g)) {
    try { const h = new URL(m[0]).hostname; if (h === "tailscale.com" || h.endsWith(".tailscale.com")) return m[0]; } catch {}
  }
  return null;
}

/** @param {number} port */
export const onArgs = port => ["funnel", "--bg", `--https=${FUNNEL_PORT}`, `--set-path=${SHARE_PATH}`, `http://127.0.0.1:${port}${SHARE_PATH}`];
export const offArgs = () => ["funnel", `--https=${FUNNEL_PORT}`, `--set-path=${SHARE_PATH}`, "off"];

/**
 * @param {any} ctx the network module's context
 * @param {{ exec?: (args: string[], opts?: { timeout?: number }) => Promise<Ran>, now?: () => number,
 *   guard?: (caller: any, meta: any) => void }} [seam] tests pass a fake tailscale as `exec`; `guard`
 *   throws unless the caller is the owner
 */
export async function startFunnel(ctx, { exec = tsRun, now = Date.now, guard = () => {} } = {}) {
  const net = () => (ctx.config && ctx.config.network) || {};
  /** The toggle as last heard: { on, port }. Kept in config so a restart reconciles from it. */
  /** @type {{ on: boolean, port: number|null } | null} */
  let mem = null;   // a context with no home to save in (tests) keeps the toggle here
  const saved = () => {
    if (mem) return mem;
    const w = net().funnel && net().funnel.share;
    return { on: Boolean(w && w.on === true), port: w && Number.isInteger(w.port) ? /** @type {number} */ (w.port) : null };
  };
  const persist = (/** @type {{ on: boolean, port: number|null }} */ w) => {
    if (!ctx.paths) { mem = w; return; }
    try { config.save({ network: { funnel: { share: { on: w.on, port: w.port } } } }, ctx.paths.root, ctx.config); }
    catch (e) { ctx.log(`funnel: could not save the toggle (${String(/** @type {Error} */ (e).message).slice(0, 120)})`); }
  };

  /** @type {FunnelState} */
  let state = { state: "off", wanted: false, port: null, base: null, consentUrl: null, why: null, since: now() };
  let lastTry = 0;
  /** Changes run one after another, and the last toggle wins. */
  let chain = Promise.resolve();
  let stopped = false;

  const set = (/** @type {Partial<FunnelState>} */ patch) => {
    const next = { ...state, ...patch };
    const changed = ["state", "wanted", "port", "base", "consentUrl", "why"].some(k => /** @type {any} */ (next)[k] !== /** @type {any} */ (state)[k]);
    state = changed ? { ...next, since: now() } : state;
    if (changed && !stopped) {
      try { ctx.events.emit("funnel.changed", { state: state.state, wanted: state.wanted, base: state.base, consentUrl: state.consentUrl, why: state.why, since: state.since }); } catch {}
    }
  };

  /** This node's DNS name, or why not. */
  async function self() {
    const r = await exec(["status", "--json"], { timeout: 8000 });
    if (r.code === 127) return { why: "Tailscale is not installed here" };
    /** @type {any} */ let s;
    try { s = JSON.parse(r.out); } catch { return { why: (r.err || r.out).trim().split("\n")[0] || "tailscale status failed" }; }
    if (s.BackendState && s.BackendState !== "Running") return { why: `Tailscale is ${s.BackendState} here` };
    const dns = s.Self && typeof s.Self.DNSName === "string" ? s.Self.DNSName.replace(/\.$/, "") : "";
    return dns ? { dns } : { why: "Tailscale does not give this node a name yet" };
  }

  async function readShare() {
    const r = await exec(["funnel", "status", "--json"], { timeout: 8000 });
    if (r.code !== 0) return null;
    try { return parseShare(r.out.trim() ? JSON.parse(r.out) : {}); } catch { return null; }
  }

  /** Tell artifacts the public base, best effort: its links are never blocked on this. */
  async function tell(/** @type {string|null} */ base) {
    try { await ctx.call("artifacts.public.base", { base }); }
    catch (e) { ctx.log(`funnel: artifacts.public.set failed (${String(/** @type {Error} */ (e).message).slice(0, 120)})`); }
  }

  /** Make Funnel match the toggle, then tell artifacts. */
  async function apply() {
    const want = saved();
    lastTry = now();
    // The port is artifacts' own answer (its pid-checked share server), never the event's.
    let port = want.port;
    if (want.on) {
      let st = null;
      try { st = /** @type {any} */ (await ctx.call("artifacts.public.status", {})); } catch {}
      const p = st && st.available === true && Number.isInteger(st.port) && st.port > 0 && st.port < 65536 ? /** @type {number} */ (st.port) : null;
      if (!p) { set({ state: "error", wanted: true, port: null, base: null, consentUrl: null, why: "the share server is not running on this box" }); return; }
      port = p;
      if (p !== want.port) persist({ on: true, port: p });
    }
    const me = await self();
    if (!("dns" in me)) {
      // Turning off with Tailscale gone leaves nothing of ours to turn off.
      if (!want.on) { set({ state: "off", wanted: false, port, base: null, consentUrl: null, why: null }); await tell(null); return; }
      set({ state: "error", wanted: true, port, base: null, consentUrl: null, why: me.why || "Tailscale is not available" });
      return;
    }
    const base = `https://${me.dns}:${FUNNEL_PORT}`;
    const cur = await readShare();
    if (!want.on) {
      if (!cur || cur.served) {
        const r = await exec(offArgs(), { timeout: CLI_TIMEOUT });
        if (r.code !== 0 && cur) {
          set({ state: "error", wanted: false, port, base: null, consentUrl: null, why: (r.err || r.out).trim().split("\n")[0] || "tailscale funnel off failed" });
          return;
        }
      }
      set({ state: "off", wanted: false, port, base: null, consentUrl: null, why: null });
      await tell(null);
      return;
    }
    if (!port) { set({ state: "error", wanted: true, port, base: null, consentUrl: null, why: "the share server's port is not known" }); return; }
    const target = `http://127.0.0.1:${port}${SHARE_PATH}`;
    const ok = cur && cur.served && cur.funnel && cur.target && trimSlash(cur.target) === trimSlash(target);
    if (!ok) {
      const r = await exec(onArgs(port), { timeout: CLI_TIMEOUT });
      const text = `${r.out}\n${r.err}`;
      const url = consentUrl(text);
      if (url) { set({ state: "needs-consent", wanted: true, port, base: null, consentUrl: url, why: "Tailscale needs your OK before it can publish a public link" }); await tell(null); return; }
      if (r.code !== 0) {
        set({ state: "error", wanted: true, port, base: null, consentUrl: null, why: text.trim().split("\n").find(Boolean) || "tailscale funnel failed" });
        return;
      }
    }
    set({ state: "on", wanted: true, port, base, consentUrl: null, why: null });
    await tell(base);
  }

  /** Queue an apply; a failure is the state's error, never a throw into the event bus. */
  const queue = () => {
    chain = chain.then(() => (stopped ? undefined : apply())).catch(e => {
      set({ state: "error", why: String((e && e.message) || e).slice(0, 200) });
    });
    return chain;
  };

  const off = ctx.events.on("artifact-links.changed", (/** @type {any} */ ev) => {
    // Only the artifacts module may turn this on: any module could otherwise emit the event.
    if (!ev || ev.source !== "artifacts") return;
    const p = ev.payload;
    if (!p || typeof p.on !== "boolean") return;
    // Only the share path is ours; anything else this event might name is ignored.
    if (p.path !== undefined && p.path !== SHARE_PATH) return;
    persist({ on: p.on, port: saved().port });
    queue();
  });

  ctx.tool("network.funnel.status", {
    effect: "write",
    description: "The public share path on Tailscale Funnel: off, on with the public base URL, or needs-consent with the Tailscale link the person follows once (the funnel attribute, HTTPS certificates). Reading it while consent is pending checks again, at most every five seconds. The owner's.",
    input: { type: "object", properties: {} },
    run: async (_, meta = {}) => {
      guard(meta.caller, meta);
      if (state.state === "needs-consent" && saved().on && now() - lastTry >= RETRY_MS) await queue();
      return { ...state };
    },
  });

  // Reconcile at start from the persisted toggle: after a restart, Funnel is made to match it.
  // Nothing persisted means the person never turned links on, and Funnel is left alone.
  const start = saved();
  if (start.on || (net().funnel && net().funnel.share)) queue();

  return {
    /** The state now. */
    state: () => ({ ...state }),
    /** Resolves when the queued changes have run. */
    idle: () => chain,
    async stop() { stopped = true; off(); await chain.catch(() => {}); },
  };
}
