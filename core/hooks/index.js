// @ts-check
// hooks: inbound webhooks from the public internet, through Tailscale Funnel (ADR 0014 part 10).
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
//
// Funnel terminates at tailscaled's serve proxy, which ADR 0002 rejects for identity. That does
// not matter here: a webhook has no identity to forge, only a signature to check. Vyre never runs
// `tailscale funnel` to change anything; hooks.status reads `funnel status --json` and shows the
// person the exact commands (funnel.js).

import * as config from "../config/index.js";
import { run as tailscale } from "../names/tailscale.js";
import { listen, HOST, BODY_LIMIT, PER_MINUTE } from "./listener.js";
import { SCHEMES, verify } from "./verify.js";
import { Deliveries, MIGRATIONS } from "./deliveries.js";
import { parseFunnel, funnelNode, mismatches, openCommand, closeCommand, offCommand, dockerPrefix, FUNNEL_PORT } from "./funnel.js";

/**
 * Test seams, keyed by the VYRE_HOME a registry runs with: { now }. Production never sets them.
 * @type {Map<string, { now?: () => number }>}
 */
export const seams = new Map();

export const DEFAULT_PORT = 7310;

const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const VAULT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const HEADER = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Headers that carry something else, or that a proxy on the way may set. */
const NOT_A_SIGNATURE = /^(?:content-type|content-length|transfer-encoding|host|user-agent|connection|cookie|x-forwarded-.*|tailscale-.*|forwarded)$/;

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
    /** The open route by that name, own keys only: /hooks/constructor is not a route. */
    const routeOf = name => Object.hasOwn(cfg().routes, name) ? cfg().routes[name] : null;
    const save = patch => {
      if (!ctx.paths) throw new Error("this vyred has no home to save config in");
      config.save({ hooks: patch }, ctx.paths.root, ctx.config);
    };

    /**
     * One request that reached an open route with a body in the limits. Returns the status code.
     * The secret is fetched for this check and dropped after it; it is never logged, stored,
     * emitted or put in an error, and nor is the signature it would have produced.
     */
    async function accept(name, headers, body) {
      const route = routeOf(name);
      if (!route) return 404;
      const who = `internet:${name}`;
      let secret = "";
      try { secret = String((await ctx.vault.fetch(route.secret)) ?? ""); }
      catch (e) {
        ctx.log(`${who}: refused, its secret ${route.secret} is not available (${String(/** @type {Error} */ (e).message).slice(0, 200)})`);
        return 503;
      }
      const v = verify(route, headers, body, secret, now());
      secret = "";
      if (!v.ok) { ctx.log(`${who}: refused, ${v.why}`); return 401; }
      const d = store.add(name, headers, body);
      if (d.duplicate) { ctx.log(`${who}: the same body as ${d.id}, so not stored or announced again`); return 200; }
      const at = new Date(d.at).toISOString();
      ctx.events.emit("hook.received", { route: name, id: d.id, bytes: body.length, at });
      ctx.log(`${who}: stored ${d.id}, ${body.length} bytes`);
      return 200;
    }

    /** @type {{ port: number, close: () => Promise<void> } | null} */
    let live = null;
    let listenError = /** @type {string|null} */ (null);
    /** Make the listener match the setting: open when enabled, gone when not. */
    async function apply() {
      const c = cfg();
      if (c.enabled && !live) {
        try {
          live = await listen({ port: c.port, now, log: ctx.log, accept, open: name => Boolean(routeOf(name)) });
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
    const routeOut = (name, r) => ({
      name, path: `/hooks/${name}`, verify: { scheme: r.scheme, header: r.header, secret: r.secret }, opened: r.opened || null,
      deliveries: store.count(name), recent: store.recent(name),
      funnel: { open: openCommand(name, port()), close: closeCommand(name) },
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
      description: "The webhook listener's state and every open route: its path, signature scheme, header and vault item (a name, never a value), how many deliveries are kept, the newest few (id, at, bytes), and the Funnel commands to publish or close it.",
      input: obj({}),
      run: async (_i, { caller }) => {
        reader(caller);
        return { ...state(), routes: Object.entries(cfg().routes).map(([n, r]) => routeOut(n, r)) };
      },
    });

    ctx.tool("hooks.open", {
      description: "Open one webhook route, /hooks/<name>, checked by the sender's signature: scheme hmac-sha256 (hex HMAC of the body in the header you name), github (X-Hub-Signature-256) or stripe (Stripe-Signature, 5 minute tolerance). secret is the vault item holding the signing secret, granted to the hooks module. A route with no scheme is refused. The owner's, never an agent's. Vyre does not publish it: the result has the tailscale funnel command for the person to run.",
      input: obj({ name: str, verify: obj({ scheme: { type: "string", enum: Object.keys(SCHEMES) }, header: str, secret: str }, ["scheme", "secret"]) }, ["name", "verify"]),
      presence: { summary: i => `Open /hooks/${i && i.name} to the internet, accepting only deliveries with a valid ${i && i.verify && i.verify.scheme} signature` },
      run: async ({ name, verify: v }, { caller }) => {
        owner(caller, "opening a webhook route");
        if (!NAME.test(name) || name.length > 40) throw refuse(`"${name}" is not a route name: lowercase words joined by dashes, like northwind-orders`, "bad_input");
        const scheme = /** @type {keyof typeof SCHEMES} */ (v && v.scheme);
        if (!SCHEMES[scheme]) throw refuse("a route needs a signature scheme: hmac-sha256, github or stripe", "bad_input");
        const header = String(v.header || SCHEMES[scheme].header || "").toLowerCase();
        if (!header) throw refuse("hmac-sha256 needs the header the sender puts its signature in", "bad_input");
        if (!HEADER.test(header) || NOT_A_SIGNATURE.test(header)) throw refuse(`${header} cannot carry a signature`, "bad_input");
        if (!VAULT_NAME.test(String(v.secret || ""))) throw refuse("secret is the name of a vault item, like northwind-orders-hook", "bad_input");
        const routes = cfg().routes;
        if (routeOf(name)) throw refuse(`${name} is already open; close it first to change how it is checked`, "conflict");
        // Whether the secret can be fetched now. The value is dropped at once; this only tells
        // the person whether a grant is still missing.
        let ready = true, why = null;
        try { await ctx.vault.fetch(v.secret); } catch (e) { ready = false; why = /** @type {Error} */ (e).message; }
        const route = { scheme, header, secret: String(v.secret), opened: new Date(now()).toISOString() };
        save({ routes: { ...routes, [name]: route } });
        ctx.events.emit("hook.opened", { route: name, scheme });
        ctx.log(`route ${name} opened (${scheme}) by ${caller}`);
        return {
          ...routeOut(name, route), ready, ...(why ? { why, grant: `vyre vault grant ${v.secret} hooks` } : {}), listener: state(),
          next: [
            ...(cfg().enabled ? [] : ["turn the listener on with hooks.enable { on: true }"]),
            ...(ready ? [] : [`let the hooks module use the secret: vyre vault grant ${v.secret} hooks`]),
            `publish the path with Funnel (on a Docker box, prefix: ${dockerPrefix.trim()}): ${openCommand(name, port())}`,
            `give the sender the address from hooks.status, https://<box>.<tailnet>.ts.net:${FUNNEL_PORT}/hooks/${name}`,
          ],
        };
      },
    });

    ctx.tool("hooks.close", {
      description: "Close one webhook route. vyred answers 404 on its path at once; the result has the tailscale funnel command that stops publishing it, and when it was the last route, the one that turns the Funnel port off. The owner's, never an agent's.",
      input: obj({ name: str }, ["name"]),
      presence: { summary: i => `Close /hooks/${i && i.name}` },
      run: async ({ name }, { caller }) => {
        owner(caller, "closing a webhook route");
        const routes = { ...cfg().routes };
        if (!routeOf(name)) throw refuse(`no open route ${name}`, "not_found");
        delete routes[name];
        // Replacing the whole routes object: save() merges one level deep, so a patch of
        // { routes: {...} } replaces routes.
        save({ routes });
        ctx.events.emit("hook.closed", { route: name });
        ctx.log(`route ${name} closed by ${caller}`);
        const last = Object.keys(routes).length === 0;
        return {
          route: name, closed: true, funnel: { close: closeCommand(name), ...(last ? { off: offCommand() } : {}) },
          note: "Until the Funnel command runs, Funnel still forwards the path; vyred answers 404 there, so nothing gets in",
        };
      },
    });

    ctx.tool("hooks.status", {
      description: "The listener, the open routes, and what Tailscale Funnel is publishing from this node (read with tailscale funnel status --json, never changed): each route's public address, whether the policy grants the funnel attribute, and every mismatch (a route Funnel does not publish, a Funnel path with no route, anything on 443), with the command that fixes it.",
      input: obj({}),
      run: async (_i, { caller }) => {
        reader(caller);
        const c = cfg();
        const names = Object.keys(c.routes);
        const [fs, st] = await Promise.all([tailscale(["funnel", "status", "--json"]), tailscale(["status", "--json"])]);
        /** @type {any} */
        let funnel;
        if (fs.code === 127) funnel = { read: false, why: "Tailscale is not installed", serving: [] };
        else if (fs.code !== 0) funnel = { read: false, why: (fs.err || fs.out).trim().split("\n")[0] || `tailscale funnel status exited ${fs.code}`, serving: [] };
        else {
          try { funnel = { read: true, serving: parseFunnel(fs.out.trim() ? JSON.parse(fs.out) : {}) }; }
          catch { funnel = { read: false, why: "tailscale funnel status --json did not print JSON", serving: [] }; }
        }
        let node = { dnsName: null, funnel: false, https: false, ports: null };
        try { if (st.code === 0) node = funnelNode(JSON.parse(st.out)); } catch {}
        const host = node.dnsName || (funnel.serving.find(s => s.funnel && s.host) || {}).host || null;
        const problems = funnel.read ? mismatches(names, funnel.serving, { port: port(), enabled: c.enabled }) : [];
        if (st.code === 0 && !node.funnel && names.length) problems.push({ kind: "no-funnel-attr", harmless: false, message: "the tailnet policy does not give this node the funnel attribute, so Funnel cannot publish anything", fix: null });
        if (st.code === 0 && !node.https && names.length) problems.push({ kind: "no-https", harmless: false, message: "HTTPS certificates are off for this tailnet; Funnel needs them (admin console, DNS, Enable HTTPS)", fix: null });
        if (node.ports && !node.ports.includes(FUNNEL_PORT)) problems.push({ kind: "port-not-allowed", harmless: false, message: `the policy limits Funnel to ports ${node.ports.join(", ")}, which leaves out ${FUNNEL_PORT}`, fix: null });
        return {
          ...state(), routes: names, node, funnel,
          urls: Object.fromEntries(names.map(n => [n, host ? `https://${host}:${FUNNEL_PORT}/hooks/${n}` : null])),
          mismatches: problems,
          commands: Object.fromEntries(names.map(n => [n, { open: openCommand(n, port()), close: closeCommand(n) }])),
          docker: `On a Docker box, run each command as: ${dockerPrefix}<command>`,
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
        if (!d) throw refuse(`no delivery ${id}; deliveries are kept for 7 days, the newest 500`, "not_found");
        return d;
      },
    });

    await apply();
    return { async stop() { if (live) { const l = live; live = null; await l.close(); } } };
  },
};
