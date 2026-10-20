// @ts-check
// hooks: inbound webhooks from the public internet (ADR 0014 part 10; the way in is the Wink public gate, core/wink/control/gate.js: POST /hooks/<route> on https://<name>.vyre.run:7443).
//
// This is the only part of Vyre the internet reaches, so it is built to do almost nothing:
//   - Off by default (config hooks.enabled). Off means no listener at all.
//   - Routes open one at a time, by a person (hooks.open, which needs presence), each with the
//     sender's signature scheme and the vault item holding its secret. No scheme, no route.
//   - A request that verifies is stored in hooks_deliveries and announced as hook.received
//     { route, id, bytes, at }. That is all it can do. It never calls a tool, never reaches the
//     Gate, and touches the vault only for its own route's secret. Its caller class is
//     internet:<route>, which exists for the audit trail and nothing else.
//   - A watcher that listens for hook.received on its route gets the delivery handed to it by
//     the watcher runtime, which reads it with hooks.delivery.
//   - A Flow whose trigger asks for its own webhook address (trigger.address, "A webhook is called", "A form is
//     submitted", "A person signs up") gets one route, bound to it by id: /hooks/<flow-slug>-<token>, the token scheme
//     (32 random bytes made by the Vault, kept there as hooks-<route>, never logged). The person's yes when they turn
//     the Flow on covers opening it and turning the listener on; turning the Flow off closes it, and hooks.flow.renew
//     makes a new token, so the old address stops working. Only a Flow an owner or an admin approved gets one.
//
// A webhook has no identity to forge, only a signature to check, so whatever carries it to the loopback listener needs no trust of its own. The Wink public gate carries
// POST /hooks/<route> from the internet to this listener (core/wink/control/gate.js); until the box has its public address hooks.status says so, and a route that is open still stores what reaches the listener.

import * as config from "../config/index.js";
import crypto from "node:crypto";
import { listen, sendTest, HOST, BODY_LIMIT, PER_MINUTE } from "./listener.js";
import { SCHEMES, TOKEN, verify } from "./verify.js";
import { Deliveries, MIGRATIONS } from "./deliveries.js";
import { startFlows as handToFlows } from "./flow-body.js";
import { isPerson } from "../../lib/caller.js";
import { roleAtLeast } from "../../lib/spaces/members.js";

/**
 * Test seams, keyed by the VYRE_HOME a registry runs with: { now, flowsHost, space }. Production never sets them.
 * @type {Map<string, { now?: () => number, flowsHost?: any, space?: string }>}
 */
export const seams = new Map();

/** Does this Flow ask for its own webhook address? A web trigger with `address: true`, on its own or among its triggers. @param {any} flow */
export const wantsAddress = flow => (flow && Array.isArray(flow.triggers) ? flow.triggers : [flow && flow.trigger]).some(t => t && t.on === "web" && t.address === true);

/** The readable part of a Flow's address: its label or name as lowercase words joined by dashes, at most 30 characters, starting with a letter. @param {any} flow */
export function slugOf(flow) {
  const words = String((flow && (flow.label || flow.name)) || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30).replace(/-+$/, "");
  return !words ? "flow" : /^[a-z]/.test(words) ? words : `flow-${words}`.slice(0, 30).replace(/-+$/, "");
}

export const DEFAULT_PORT = 7310;

const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const VAULT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const HEADER = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Headers that carry something else, or that a proxy on the way may set. */
const NOT_A_SIGNATURE = /^(?:content-type|content-length|transfer-encoding|host|user-agent|connection|cookie|x-forwarded-.*|forwarded)$/;

const isAgent = caller => /(?:^|[\s:])agent:/.test(String(caller || ""));
const isPublic = caller => /^(?:internet|tailnet-guest):/.test(String(caller || ""));
const refuse = (message, code = "denied") => Object.assign(new Error(message), { code });

/** Anyone may read what is open, except a guest or the internet. */
function reader(caller) {
  if (isPublic(caller)) throw refuse("hooks are the owner's");
}

/** Only a person, never an agent, a guest, the internet or another module, changes what is open. */
function owner(caller, what) {
  const c = String(caller || "");
  if (isAgent(c)) throw refuse(`"${c}" is an agent; ${what} is the owner's to do`);
  if (c.startsWith("module:")) throw refuse(`${what} is a person's to do, not a module's`);
  reader(c);
}

/** A Flow's address carries its token, so reading it, renewing it, testing it and setting its check are the person's own surface only (lib/caller.js): never a model (mcp, harness), an agent, a module or a guest. */
function person(caller, what) {
  owner(caller, what);
  if (!isPerson(String(caller || ""))) throw refuse(`${what} is the person's own, from their own Vyre app or the vyre command`);
}

const str = { type: "string" };
const obj = (properties, required = []) => ({ type: "object", required, properties });

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    ctx.store.migrate(MIGRATIONS);
    const seam = (ctx.paths && seams.get(ctx.paths.root)) || {};
    const now = seam.now || Date.now;
    const store = new Deliveries(ctx.store.db, now);

    /** The setting, with defaults: { enabled, port, routes }. */
    const cfg = () => {
      const h = (ctx.config && ctx.config.hooks) || {};
      const port = Number.isInteger(h.port) && h.port >= 0 && h.port < 65536 ? h.port : DEFAULT_PORT;
      const routes = h.routes && typeof h.routes === "object" && !Array.isArray(h.routes) ? h.routes : {};
      return { enabled: h.enabled === true, port, routes };
    };
    /** The route by that name, open or not, own keys only: /hooks/constructor is not a route. */
    const entry = name => Object.hasOwn(cfg().routes, name) && cfg().routes[name] && typeof cfg().routes[name] === "object" ? cfg().routes[name] : null;
    /** The open route by that name. A Flow's route is kept while the Flow is off (open: false), so turning it on again gives the same address. */
    const routeOf = name => { const r = entry(name); return r && !(r.flow && r.open === false) ? r : null; };
    /**
     * Which open route a path name is, for the listener: true for a route opened by hand; { key, token } for a Flow's route, the token split off the end (/hooks/<route>-<token>), or none in the
     * path when it comes in an Authorization: Bearer header (/hooks/<route>). The token is only carried to the check, never logged or kept.
     * @param {string} name
     */
    const resolve = name => {
      const r = routeOf(name);
      if (r) return r.flow ? { key: name, token: "" } : true;
      const i = name.lastIndexOf("-");
      if (i <= 0) return null;
      const key = name.slice(0, i), fr = routeOf(key);
      return fr && fr.flow ? { key, token: name.slice(i + 1) } : null;
    };
    /** The Flows assembly and the home's Space: Flow addresses are the home Space's. */
    const flowsHost = () => seam.flowsHost || ctx.flowsHost || null;
    const homeSpace = () => seam.space || (ctx.kernel && typeof ctx.kernel.space === "string" ? ctx.kernel.space : null);
    /** Did an owner or an admin approve it? A member's own Flow does not open a door to the internet. @param {any} h @param {any} approver */
    const staffApproved = (h, approver) => Boolean(approver && approver.kind === "person" && h && typeof h.roleOf === "function" && roleAtLeast(String(h.roleOf(String(approver.id))), "admin"));
    /** Is this Flow route's Flow on, still asking for an address, and approved by an owner or an admin? @param {any} route */
    const flowLive = async route => {
      const host = flowsHost(), h = host && route.space ? host.get(route.space) : null;
      if (!h) return false;
      const v = await h.flows.store.active(route.flow).catch(() => null);
      return Boolean(v && wantsAddress(v.flow) && staffApproved(h, v.approver));
    };
    /** The last delivery each route saw, accepted or refused, since vyred started: time, OK or not, why, size. Never a body or a token. @type {Map<string, { at: string, ok: boolean, why?: string, bytes: number, test?: boolean }>} */
    const lastSeen = new Map();
    const note = (/** @type {string} */ key, /** @type {{ ok: boolean, why?: string, bytes: number, test?: boolean }} */ w) => lastSeen.set(key, { at: new Date(now()).toISOString(), ok: w.ok, ...(w.why ? { why: w.why } : {}), bytes: w.bytes, ...(w.test ? { test: true } : {}) });
    /** Send a test: the nonces a test delivery carries (x-vyre-test), each good once for 30 seconds. @type {Map<string, number>} */
    const tests = new Map();
    const isTest = (/** @type {any} */ headers) => {
      const given = typeof headers["x-vyre-test"] === "string" ? headers["x-vyre-test"] : "";
      for (const [n, until] of tests) {
        if (until < now()) { tests.delete(n); continue; }
        const a = Buffer.from(given), b = Buffer.from(n);
        if (a.length === b.length && crypto.timingSafeEqual(a, b)) { tests.delete(n); return true; }
      }
      return false;
    };
    const save = patch => {
      if (!ctx.paths) throw new Error("this vyred has no home to save config in");
      config.save({ hooks: patch }, ctx.paths.root, ctx.config);
    };

    /**
     * One request that reached an open route with a body in the limits. Returns the status code.
     * The secret is fetched for this check and dropped after it; it is never logged, stored,
     * emitted or put in an error, and nor is the signature it would have produced.
     */
    async function accept(name, headers, body, token = "") {
      const route = routeOf(name);
      if (!route) return 404;
      const who = `internet:${name}`;
      const bytes = body.length;
      /** A refusal: its reason and size in the log and the route's last delivery, never the body, the token or the secret. A Flow's address answers 404 as if it were not there. */
      const no = (/** @type {string} */ why, /** @type {number} */ code) => { note(name, { ok: false, why, bytes }); ctx.log(`${who}: refused, ${why} (${bytes} bytes)`); return code; };
      if (route.flow && !(await flowLive(route))) { void sync(); return no("its Flow is off", 404); }
      /** One check: the route's own token or secret, fetched for it and dropped after it. @param {any} how @param {string} item @param {string} given */
      const check = async (how, item, given) => {
        let secret = "";
        try { secret = String((await ctx.vault.fetch(item)) ?? ""); }
        catch (e) { return { code: 503, why: `its ${how.scheme === TOKEN ? "token" : "secret"} ${item} is not available (${String(/** @type {Error} */ (e).message).slice(0, 200)})` }; }
        const v = verify(how, headers, body, secret, now(), given);
        secret = "";
        return v.ok ? null : { code: route.flow && how.scheme === TOKEN ? 404 : 401, why: v.why };
      };
      const first = await check(route, route.secret, token);
      if (first) return no(first.why, first.code);
      const sig = route.flow && route.sign && typeof route.sign === "object" ? route.sign : null;
      if (sig) { const second = await check({ scheme: sig.scheme, header: sig.header }, sig.secret, ""); if (second) return no(second.why, second.code); }
      if (route.flow && isTest(headers)) { note(name, { ok: true, bytes, test: true }); ctx.log(`${who}: a test delivery from Vyre checked, ${bytes} bytes; nothing started`); return 200; }
      note(name, { ok: true, bytes });
      const d = store.add(name, headers, body);
      if (d.duplicate) { ctx.log(`${who}: the same body as ${d.id}, so not stored or announced again`); return 200; }
      const at = new Date(d.at).toISOString();
      ctx.events.emit("hook.received", { route: name, id: d.id, bytes, at });
      ctx.log(`${who}: stored ${d.id}, ${bytes} bytes`);
      const type = String(headers["content-type"] || "");
      void handToFlows(flowsHost() || undefined, name, route, d.id, Buffer.isBuffer(body) || body instanceof Uint8Array ? Buffer.from(body).toString("utf8") : String(body), ctx.log, told, type).catch(e => ctx.log(`internet:${name}: ${String(e && e.message || e).slice(0, 160)}`));
      return 200;
    }

    /** Routes already told that they have no recorded Space. */
    const told = new Set();

    /** @type {{ port: number, close: () => Promise<void> } | null} */
    let live = null;
    let listenError = /** @type {string|null} */ (null);
    /** Make the listener match the setting: open when enabled, gone when not. */
    async function apply() {
      const c = cfg();
      if (c.enabled && !live) {
        try {
          live = await listen({ port: c.port, now, log: ctx.log, accept, note, open: resolve });
          listenError = null;
          ctx.log(`listening on ${HOST}:${live.port} for ${Object.keys(c.routes).length} route(s)`);
        } catch (e) {
          listenError = /** @type {Error} */ (e).message;
          ctx.log(`could not listen on ${HOST}:${c.port}: ${listenError}`);
        }
      } else if (!c.enabled && live) {
        const l = live;
        live = null;
        await l.close();
        ctx.log("listener closed");
      }
      if (!c.enabled) listenError = null;
    }

    const port = () => live ? live.port : cfg().port;
    const state = () => ({ enabled: cfg().enabled, host: HOST, port: port(), listening: Boolean(live), ...(listenError ? { error: listenError } : {}) });
    /** A route as hooks.list shows it. A Flow's route shows no token: its address is the person's to read, with hooks.flow. */
    const routeOut = (name, r) => r.flow ? ({
      name, path: `/hooks/${name}-<token>`, flow: r.flow, open: r.open !== false, verify: { scheme: TOKEN, header: r.sign ? r.sign.header : "the address, or Authorization: Bearer", secret: r.secret, ...(r.sign ? { signature: r.sign.scheme } : {}) },
      opened: r.opened || null, space: r.space || null, deliveries: store.count(name), recent: store.recent(name),
    }) : ({
      name, path: `/hooks/${name}`, verify: { scheme: r.scheme, header: r.header, secret: r.secret }, opened: r.opened || null, space: r.space || null,
      deliveries: store.count(name), recent: store.recent(name),
    });

    ctx.tool("hooks.enable", {
      description: "Turn the webhook listener on or off (config hooks.enabled). On, vyred listens on 127.0.0.1 only, for the routes opened with hooks.open; off, there is no listener at all. The owner's, never an agent's.",
      input: obj({ on: { type: "boolean" } }, ["on"]),
      presence: { summary: i => i && i.on === true ? `Listen for webhooks from the internet on ${HOST}:${cfg().port}, for the routes you open` : "Stop listening for webhooks" },
      run: async ({ on }, { caller }) => {
        owner(caller, "turning webhooks on or off");
        save({ enabled: on === true });
        await apply();
        ctx.log(`hooks ${on ? "on" : "off"}, set by ${caller}`);
        return { ...state(), limits: { bodyBytes: BODY_LIMIT, perMinute: PER_MINUTE } };
      },
    });

    ctx.tool("hooks.list", {
      description: "The webhook listener's state and every open route: path, signature scheme, header, vault item name, kept deliveries and the newest few.",
      input: obj({}),
      run: async (_i, { caller }) => {
        reader(caller);
        return { ...state(), routes: Object.entries(cfg().routes).map(([n, r]) => routeOut(n, r)) };
      },
    });

    ctx.tool("hooks.open", {
      description: "Open one webhook route, /hooks/<name>, checked by the sender's signature: scheme hmac-sha256 (hex HMAC of the body in the header you name), github (X-Hub-Signature-256) or stripe (Stripe-Signature, 5 minute tolerance). secret is the vault item holding the signing secret, granted to the hooks module. A route with no scheme is refused. The owner's, never an agent's. It is stored and verified here; it is reachable from the internet at the box's public address once that is up (hooks.status says when).",
      // The scheme, header and secret are plain top-level fields, so the person's card carries them as they are; `verify: { scheme, header, secret }` is the same thing in the older nested form and is still taken.
      input: obj({ name: str, scheme: { type: "string", enum: Object.keys(SCHEMES) }, header: str, secret: str, verify: obj({ scheme: { type: "string", enum: Object.keys(SCHEMES) }, header: str, secret: str }, ["scheme"]) }, ["name"]),
      presence: { summary: i => `Open /hooks/${i && i.name} to the internet, accepting only deliveries with a valid ${i && (i.verify || i).scheme} signature${i && !(i.verify || i).secret ? `; make a signing secret for it in your Vault (hooks-${i.name}) and let the hooks module use it` : ""}` },
      run: async (input, { caller }) => {
        const { name } = input;
        const v = input.verify && typeof input.verify === "object" ? input.verify : { scheme: input.scheme, header: input.header, secret: input.secret };
        owner(caller, "opening a webhook route");
        if (!NAME.test(name) || name.length > 40) throw refuse(`"${name}" is not a route name: lowercase words joined by dashes, like northwind-orders`, "bad_input");
        const scheme = /** @type {keyof typeof SCHEMES} */ (v && v.scheme);
        if (!Object.hasOwn(SCHEMES, scheme)) throw refuse("a route needs a signature scheme: hmac-sha256, github or stripe", "bad_input");
        const header = String(v.header || SCHEMES[scheme].header || "").toLowerCase();
        if (!header) throw refuse("hmac-sha256 needs the header the sender puts its signature in", "bad_input");
        if (!HEADER.test(header) || NOT_A_SIGNATURE.test(header)) throw refuse(`${header} cannot carry a signature`, "bad_input");
        const make = v.secret === undefined || v.secret === "";
        if (!make && !VAULT_NAME.test(String(v.secret || ""))) throw refuse("secret is the name of a vault item, like northwind-orders-hook", "bad_input");
        const routes = cfg().routes;
        if (entry(name)) throw refuse(entry(name).flow ? `${name} is a Flow's own webhook address; pick another name` : `${name} is already open; close it first to change how it is checked`, "conflict");
        // No item named: the Vault makes the signing secret (32 random bytes) as hooks-<name> and grants it to this module. The value is never in this reply, the log or an event; the person reads it from the Vault.
        let secretItem = String(v.secret || "");
        if (make) {
          secretItem = `hooks-${name}`;
          const made = /** @type {any} */ (await ctx.call("vault.make-hook-secret", { name: secretItem }));
          if (made.error) throw refuse(`the signing secret could not be made: ${String(made.error.message || made.error.code).slice(0, 200)}. Name a Vault item that already holds the secret (the secret field of verify) instead, or ask the owner to check the Vault.`, "unavailable");
        }
        // Whether the secret can be fetched now. The value is dropped at once; this only tells
        // the person whether a grant is still missing.
        let ready = true, why = null;
        try { await ctx.vault.fetch(secretItem); } catch (e) { ready = false; why = /** @type {Error} */ (e).message; }
        // The Space the route is opened for, the one a delivery may start Flows in (null where this box cannot say: the route then starts no Flow).
        const space = ctx.kernel && typeof ctx.kernel.space === "string" ? ctx.kernel.space : null;
        const route = { scheme, header, secret: secretItem, opened: new Date(now()).toISOString(), ...(space ? { space } : {}) };
        save({ routes: { ...routes, [name]: route } });
        ctx.events.emit("hook.opened", { route: name, scheme });
        ctx.log(`route ${name} opened (${scheme}) by ${caller}`);
        return {
          ...routeOut(name, route), ready, ...(make ? { secret_made: secretItem, reveal: `The signing secret is in your Vault as ${secretItem}; read it there (a reveal needs you present)` } : {}), ...(why ? { why, grant: `vyre vault grant ${secretItem} hooks` } : {}), listener: state(),
          next: [
            ...(cfg().enabled ? [] : ["turn the listener on with hooks.enable { on: true }"]),
            ...(ready ? [] : [`let the hooks module use the secret: vyre vault grant ${secretItem} hooks`]),
            "the route is stored and verified here; hooks.status gives the public address to hand the sender once the box has one",
          ],
        };
      },
    });

    ctx.tool("hooks.close", {
      description: "Close one webhook route. vyred answers 404 on its path at once; The owner's, never an agent's.",
      input: obj({ name: str }, ["name"]),
      presence: { summary: i => `Close /hooks/${i && i.name}` },
      run: async ({ name }, { caller }) => {
        owner(caller, "closing a webhook route");
        const routes = { ...cfg().routes };
        const gone = routeOf(name);
        if (!routeOf(name)) throw refuse(`no open route ${name} (hooks.list shows the open ones)`, "not_found");
        if (gone.flow) throw refuse(`${name} is the Flow's own webhook address: turn the Flow off to close it, or get it a new address; then retry`, "conflict");
        delete routes[name];
        // Replacing the whole routes object: save() merges one level deep, so a patch of
        // { routes: {...} } replaces routes.
        save({ routes });
        ctx.events.emit("hook.closed", { route: name });
        ctx.log(`route ${name} closed by ${caller}`);
        const last = !Object.values(routes).some(r => r && !(r.flow && r.open === false));
        return {
          route: name, closed: true, last,
          note: "vyred answers 404 on the path at once, so nothing gets in",
          ...(gone && gone.secret ? { secret_kept: `its signing secret is still in the Vault as ${gone.secret}; retire it there when you no longer need it` } : {}),
        };
      },
    });

    /** Where the internet reaches this box for webhooks: the Wink public gate's origin once it is up and the name points here (wink.network.status), else why not. */
    const publicNow = async () => {
      try {
        const r = /** @type {any} */ (await ctx.call("wink.network.status", { ping: false }));
        const g = r && r.data && r.data.ingress;
        if (g && g.base) return { available: true, base: String(g.base) };
        return { available: false, why: g && g.why ? `the public address is not up yet: ${g.why}` : "the server has no public address yet (it needs its name, and its public port reachable from the internet); a route is stored and verified here, and reachable from this server only" };
      } catch { return { available: false, why: "the server has no public address yet; a route is stored and verified here, and reachable from this server only" }; }
    };

    ctx.tool("hooks.status", {
      description: "The listener and open routes: each route's path, scheme and deliveries, whether the internet can reach it, and the address to give the sender.",
      input: obj({}),
      run: async (_i, { caller }) => {
        reader(caller);
        const names = Object.keys(cfg().routes).filter(n => !entry(n).flow);
        const pub = await publicNow();
        const live = pub.available && Boolean(state().listening);
        return {
          ...state(), routes: names,
          public: live ? { available: true, base: pub.base } : { available: false, why: pub.available ? "the listener is off; turn it on with hooks.enable { on: true }" : pub.why },
          urls: Object.fromEntries(names.map(n => [n, live ? `${pub.base}/hooks/${n}` : null])),
        };
      },
    });

    ctx.tool("hooks.delivery", {
      description: "One stored delivery by id (from a hook.received event or hooks.list): route, at, the allowlisted headers, bytes, and the body as text. For watchers and the owner; never an agent, a guest or the internet.",
      input: obj({ id: str }, ["id"]),
      callers: ["cli", "local", "deck", "capsule", "module"],
      run: async ({ id }, { caller }) => {
        if (isAgent(caller) || /^(?:mcp|harness)(?::|$)/.test(String(caller || ""))) throw refuse(`"${caller}" is a model's call; a webhook's body is read by the owner's watchers`);
        reader(caller);
        const d = store.get(id);
        if (!d) throw refuse(`no delivery ${id}; deliveries are kept for 7 days, the newest 500; hooks.list shows the recent ones`, "not_found");
        return d;
      },
    });

    // ---- A Flow's own webhook address
    /** Why a Flow that asks for an address has none, by Flow id (an approval by a member, a token the Vault could not make). @type {Map<string, string>} */
    const pending = new Map();
    /**
     * Make each Flow route match the Flows: a Flow that is on and asks for an address has its route open; one that is off, removed or no longer asks has it closed. Read from the Flows store every time, so
     * whatever starts it (a flow.switched event, the start, the clock, a delivery to a Flow that is off) carries no authority of its own. Opening a new route turns the listener on: the person's yes when they
     * turned the Flow on covers both. Runs one at a time.
     */
    async function syncNow() {
      const host = flowsHost(), space = homeSpace(), h = host && space ? host.get(space) : null;
      if (!h || !h.flows || !h.flows.store) return;
      /** @type {any[]} */ let active;
      try { active = await h.flows.store.activeFlows(); } catch (e) { ctx.log(`could not read the Flows to match their webhook addresses: ${String(/** @type {Error} */ (e).message).slice(0, 160)}`); return; }
      const want = new Map();
      pending.clear();
      for (const v of active || []) {
        if (!v || !wantsAddress(v.flow)) continue;
        if (!staffApproved(h, v.approver)) { pending.set(String(v.id), "Only an owner or an admin can turn on a Flow with a webhook address. Ask one of them to approve it."); continue; }
        want.set(String(v.id), v);
      }
      const routes = { ...cfg().routes }, at = new Date(now()).toISOString(), opened = [], closed = [];
      for (const [k, r] of Object.entries(routes)) {
        if (!r || typeof r.flow !== "string" || r.open === false || want.has(r.flow)) continue;
        routes[k] = { ...r, open: false, closed: at };
        closed.push(k);
      }
      for (const [id, v] of want) {
        const had = Object.entries(routes).find(([, r]) => r && r.flow === id);
        if (had) {
          if (had[1].open === false) { const { closed: _c, ...rest } = had[1]; routes[had[0]] = { ...rest, open: true, opened: at }; opened.push(had[0]); }
          continue;
        }
        const made = await makeToken(slugOf(v.flow), routes);
        if ("error" in made) { pending.set(id, made.error); continue; }
        routes[made.key] = { scheme: TOKEN, secret: made.item, flow: id, space, opened: at, open: true };
        opened.push(made.key);
      }
      if (!opened.length && !closed.length) return;
      save({ routes, ...(opened.length ? { enabled: true } : {}) });
      for (const k of opened) { ctx.events.emit("hook.opened", { route: k, scheme: TOKEN }); ctx.log(`route ${k} opened for its Flow ${routes[k].flow}`); }
      for (const k of closed) { ctx.events.emit("hook.closed", { route: k }); ctx.log(`route ${k} closed: its Flow ${routes[k].flow} is off`); }
      await apply();
    }
    let syncing = Promise.resolve();
    const sync = () => (syncing = syncing.then(syncNow).catch(e => ctx.log(`webhook addresses: ${String(e && e.message || e).slice(0, 160)}`)));
    /**
     * A new token in the Vault for a Flow's route: 32 random bytes as hooks-<route>, granted to this module, never returned. A name taken (by a route opened by hand, or an item the person made) takes the
     * next number. @param {string} base @param {Record<string, any>} routes @returns {Promise<{ key: string, item: string } | { error: string }>}
     */
    async function makeToken(base, routes) {
      for (let n = 1; n <= 9; n++) {
        const key = n === 1 ? base : `${base}-${n}`;
        if (Object.hasOwn(routes, key)) continue;
        const r = /** @type {any} */ (await ctx.call("vault.make-hook-secret", { name: `hooks-${key}` }));
        if (!r.error) return { key, item: `hooks-${key}` };
        const why = String(r.error.message || r.error.code || "");
        if (/already in the Vault/.test(why)) continue;
        return { error: `Vyre could not make the address's token in the Vault: ${why.slice(0, 200)}` };
      }
      return { error: "Every name for this Flow's address is taken. Rename the Flow and turn it on again." };
    }
    /** The route of one Flow, open or not. @param {string} flow @returns {[string, any] | null} */
    const routeFor = flow => Object.entries(cfg().routes).find(([, r]) => r && typeof r === "object" && r.flow === flow) || null;
    const flowArg = (/** @type {any} */ input) => {
      const id = input && typeof input.flow === "string" ? input.flow.trim() : "";
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw refuse("name the Flow by its id (flow)", "bad_input");
      return id;
    };
    /** What the Flow editor shows: the one address, why there is none, the last delivery, the signature check. The address carries the token, so only a person reads it. @param {string} flow */
    async function flowOut(flow) {
      const hit = routeFor(flow);
      const pub = await publicNow();
      const base = { flow, enabled: cfg().enabled, listening: Boolean(live), public: pub.available ? { available: true, base: pub.base } : { available: false, why: pub.why } };
      if (!hit || hit[1].open === false) {
        const why = pending.get(flow) || (hit ? "The Flow is off, so its address answers nothing. Turn the Flow on and the same address works again." : "Turn the Flow on and Vyre opens its address here.");
        return { ...base, open: false, address: null, why, last: null, check: null };
      }
      const [key, r] = hit;
      let token = "";
      try { token = String((await ctx.vault.fetch(r.secret)) ?? ""); } catch (e) { return { ...base, open: true, address: null, why: `The address's token ${r.secret} is not in the Vault for Vyre to use (${String(/** @type {Error} */ (e).message).slice(0, 160)}). Get a new address.`, last: null, check: null }; }
      const path = `/hooks/${key}-${token}`;
      token = "";
      const kept = store.recent(key, 1)[0];
      const last = lastSeen.get(key) || (kept ? { at: kept.at, ok: true, bytes: kept.bytes } : null);
      const why = !cfg().enabled ? "Webhooks are turned off on this server, so nothing reaches this address. Turn the Flow off and on again to turn them back on." : !live ? "The listener on this server did not start, so nothing reaches this address yet. Restart Vyre, then check again." : pub.available ? null : `${String(pub.why).charAt(0).toUpperCase()}${String(pub.why).slice(1)}. Senders on the internet reach it once the server has its public address.`;
      return { ...base, open: true, route: key, address: { path, url: pub.available ? `${pub.base}${path}` : null }, why, last,
        check: r.sign ? { scheme: r.sign.scheme, ...(r.sign.header ? { header: r.sign.header } : {}), secret: r.sign.secret } : null };
    }

    ctx.tool("hooks.flow", {
      description: "A Flow's own webhook address: { flow } -> the address to give the sender (it carries the token), whether the internet can reach it and why not, the last delivery (time, OK or refused, size) and the signature check if one is set. A person's, never an agent's.",
      input: obj({ flow: str }, ["flow"]),
      run: async (input, { caller }) => { person(caller, "reading a Flow's webhook address"); return flowOut(flowArg(input)); },
    });

    ctx.tool("hooks.flow.renew", {
      description: "Get a Flow a new webhook address: { flow }. A new token is made in the Vault; the old address stops working at once. A person's, never an agent's.",
      input: obj({ flow: str }, ["flow"]),
      run: async (input, { caller }) => {
        person(caller, "giving a Flow a new webhook address");
        const flow = flowArg(input), hit = routeFor(flow);
        if (!hit) throw refuse("this Flow has no webhook address yet: turn it on first", "not_found");
        const r = /** @type {any} */ (await ctx.call("vault.make-hook-secret", { name: hit[1].secret, renew: true }));
        if (r.error) throw refuse(`the new token could not be made (${String(r.error.message || r.error.code).slice(0, 200)}); retry in a moment`, "unavailable");
        lastSeen.delete(hit[0]);
        ctx.log(`route ${hit[0]} has a new token, set by ${caller}; the old address no longer works`);
        return flowOut(flow);
      },
    });

    ctx.tool("hooks.flow.test", {
      description: "Send a test to a Flow's webhook address: { flow }. One delivery through this server's own listener, with the address's token; it is checked like any other and starts nothing. A person's, never an agent's.",
      input: obj({ flow: str }, ["flow"]),
      run: async (input, { caller }) => {
        person(caller, "sending a test to a Flow's webhook address");
        const flow = flowArg(input), hit = routeFor(flow);
        if (!hit || hit[1].open === false) return { ok: false, line: "This Flow has no open address. Turn the Flow on first." };
        if (!live) return { ok: false, line: "Webhooks are turned off on this server, so the test cannot reach the address." };
        let token = "";
        try { token = String((await ctx.vault.fetch(hit[1].secret)) ?? ""); } catch { return { ok: false, line: "The address's token is not in the Vault for Vyre to use. Get a new address." }; }
        const nonce = crypto.randomBytes(24).toString("hex");
        tests.set(nonce, now() + 30_000);
        const status = await sendTest(live.port, `/hooks/${hit[0]}-${token}`, nonce).catch(() => 0);
        token = "";
        tests.delete(nonce);
        if (status === 200) return { ok: true, line: "The test reached the address and its token checked. A test does not start the Flow." };
        if (hit[1].sign) return { ok: false, line: "The test reached the address, and was refused because it carries no signature. That is expected: this address also checks a signature, so only the sender can send a real test." };
        return { ok: false, line: status === 429 ? "Too many deliveries in the last minute. Wait a minute and try again." : "The test did not get through. Check the Flow is on, then try again." };
      },
    });

    ctx.tool("hooks.flow.sign", {
      description: "Advanced, verify a signature: deliveries to a Flow's webhook address must also carry the sender's signature. { flow, scheme: hmac-sha256 (with header) | github | stripe | none, secret? (a Vault item; empty makes one) }. A person's, never an agent's.",
      input: obj({ flow: str, scheme: { type: "string", enum: [...Object.keys(SCHEMES), "none"] }, header: str, secret: str }, ["flow", "scheme"]),
      presence: { summary: i => i && i.scheme === "none" ? "Stop checking a signature on this Flow's webhook address" : `Accept deliveries to this Flow's webhook address only with a valid ${i && i.scheme} signature` },
      run: async (input, { caller }) => {
        person(caller, "setting how a Flow's webhook address is checked");
        const flow = flowArg(input), hit = routeFor(flow);
        if (!hit) throw refuse("this Flow has no webhook address yet: turn it on first", "not_found");
        const [key, route] = hit;
        const routes = { ...cfg().routes };
        if (input.scheme === "none") {
          const { sign: _s, ...rest } = route;
          routes[key] = rest;
          save({ routes });
          ctx.log(`route ${key}: no signature check, set by ${caller}`);
          return flowOut(flow);
        }
        const scheme = /** @type {keyof typeof SCHEMES} */ (input.scheme);
        if (!Object.hasOwn(SCHEMES, scheme)) throw refuse("a signature check is hmac-sha256, github or stripe", "bad_input");
        const header = String(input.header || SCHEMES[scheme].header || "").toLowerCase();
        if (!header) throw refuse("hmac-sha256 needs the header the sender puts its signature in", "bad_input");
        if (!HEADER.test(header) || NOT_A_SIGNATURE.test(header) || header === "authorization") throw refuse(`${header} cannot carry a signature`, "bad_input");
        let item = String(input.secret || "").trim(), made = false;
        if (item && !VAULT_NAME.test(item)) throw refuse("secret is the name of a Vault item, like orders-signing", "bad_input");
        if (!item) {
          item = `hooks-${key}-sign`;
          const r = /** @type {any} */ (await ctx.call("vault.make-hook-secret", { name: item }));
          if (r.error && !/already in the Vault/.test(String(r.error.message || ""))) throw refuse(`the signing secret could not be made (${String(r.error.message || r.error.code).slice(0, 200)}); retry in a moment`, "unavailable");
          made = !r.error;
        }
        routes[key] = { ...route, sign: { scheme, header, secret: item } };
        save({ routes });
        ctx.log(`route ${key}: checks a ${scheme} signature too, set by ${caller}`);
        return { ...(await flowOut(flow)), ...(made ? { secret_made: item } : {}) };
      },
    });

    // Flows turned on or off: the Flows host says so (flow.switched), and the routes are matched again. The clock does it every five minutes too, for a Flow turned on some other way (a Kit).
    const offSwitched = ctx.events.on("flow.switched", (/** @type {any} */ ev) => { const p = ev && ev.payload !== undefined ? ev.payload : ev; if (!p || !p.space || p.space === homeSpace()) void sync(); });
    const every = setInterval(() => { void sync(); }, 5 * 60_000);
    every.unref?.();
    void sync();
    await apply();
    return { async stop() { clearInterval(every); if (typeof offSwitched === "function") offSwitched(); if (live) { const l = live; live = null; await l.close(); } } };
  },
};
