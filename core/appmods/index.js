// @ts-check
// appmods: apps from the open-source world as modules (spec 0.3.0 part 8). The catalog is the manifests in catalog/ (each checked by manifest.js and pinned by digest); installing one is the owner's yes;
// it then runs as a container on this server (runtime.js), its secrets in the Vault, its webhooks becoming Vyre events and, where the manifest says so, a Flow's web trigger.
// Who may do what: reading the catalog, the card and the status is open to every caller (they hold no value); install, start, stop, remove and logs are the person's own; the hook tool answers only the daemon's
// hook door and checks the app's token itself. A model never installs an app.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { parseAppModule, cardOf, checkAppModule } from "./manifest.js";
import { createDockerDirect } from "./runtime.js";
import { createHelperDriver, hostHelperHere } from "./helper-driver.js";
import { createHostProxy, createTickets, originFor, ENTER } from "./proxy.js";
import { signingBrand } from "../../lib/brand/profile.js";

const MAX_FILE = 25 * 1024 * 1024;
const CATALOG = path.join(path.dirname(fileURLToPath(import.meta.url)), "catalog");
const str = { type: "string" };
const obj = (/** @type {any} */ properties, required = []) => ({ type: "object", properties, required });
const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });

export const MIGRATIONS = [
  `CREATE TABLE appmods_apps (
     name TEXT PRIMARY KEY, space TEXT NOT NULL, version TEXT NOT NULL, state TEXT NOT NULL, origin TEXT, hook_port INTEGER, login_email TEXT, installed INTEGER NOT NULL, note TEXT
   );`,
  `ALTER TABLE appmods_apps ADD COLUMN connection_id TEXT;`,
  `ALTER TABLE appmods_apps ADD COLUMN kit_task TEXT;`,
];

/** The catalog: every manifest in catalog/, checked. A manifest that fails the check is left out and said in the log, never half used. @param {(m: string) => void} [log] */
export function loadCatalog(log = () => {}) {
  /** @type {Map<string, any>} */ const out = new Map();
  for (const f of fs.readdirSync(CATALOG).filter(x => x.endsWith(".json")).sort()) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(CATALOG, f), "utf8"));
      const problems = checkAppModule(m);
      if (problems.length) { log(`appmods: ${f} is not an app module: ${problems.map(p => `${p.path}: ${p.message}`).join("; ")}`); continue; }
      out.set(m.name, m);
    } catch (e) { log(`appmods: ${f} could not be read: ${/** @type {Error} */ (e).message}`); }
  }
  return out;
}
/** The script a manifest's bootstrap names, from the catalog folder. @param {any} m */
export const bootstrapScript = m => fs.readFileSync(path.join(CATALOG, m.app.bootstrap.script), "utf8");

const sameToken = (/** @type {string} */ a, /** @type {string} */ b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const gen = (/** @type {string} */ kind) => kind === "hex32" ? crypto.randomBytes(32).toString("hex") : kind === "base64url32" ? crypto.randomBytes(32).toString("base64url") : crypto.randomBytes(18).toString("base64url");
/** A free TCP port above 49151 on `host`. @param {string} host */
const freePort = host => new Promise((resolve, reject) => { const s = net.createServer(); s.once("error", reject); s.listen(0, host, () => { const p = /** @type {any} */ (s.address()).port; s.close(() => resolve(p)); }); });

/**
 * What the module does with a webhook the app sent: check the token, find the mapping in the manifest, pick the data out of the body, say it as a Vyre event and, if the mapping names a Flow, start it.
 * Pure over its ports so a test drives it without a daemon.
 * @param {{ manifest: any, token: string, given: string, body: any, emit: (type: string, payload: any) => any, startFlow?: (path: string, o: { body: any, key: string, trust: "external" }) => Promise<any>,
 *   files?: { fetch: (url: string) => Promise<Uint8Array>, save: (path: string, bytes: Uint8Array) => Promise<{ path: string, size: number }> } }} p
 */
export async function handleWebhook(p) {
  if (!p.given || !sameToken(String(p.given), p.token)) throw refuse("that is not the app's token", "denied");
  const kind = p.body && typeof p.body === "object" ? String(p.body.event_type || "") : "";
  const map = (p.manifest.events || []).find((/** @type {any} */ e) => e.webhook === kind);
  if (!map) return { ignored: kind || "unknown" };
  const data = {};
  for (const [name, at] of Object.entries(map.data || {})) data[name] = pick(p.body, String(at));
  // The files the app made (the signed documents) are fetched from the app and put in the Drive folder the owner agreed to at install; their Drive paths ride on the event and into the Flow.
  if (map.files && p.files) {
    const list = pick(p.body, String(map.files.list));
    const saved = [];
    for (const doc of Array.isArray(list) ? list.slice(0, 20) : []) {
      const url = pick(doc, String(map.files.url)), name = clean(pick(doc, String(map.files.name)) ?? "file");
      if (typeof url !== "string") continue;
      const to = String(map.files.saveTo).replace(/\{([a-z_]+)\}/g, (/** @type {string} */ _m, /** @type {string} */ k) => (k === "name" ? name : clean(data[k] ?? "")));
      saved.push(await p.files.save(to, await p.files.fetch(url)));
    }
    data.files = saved;
  }
  const key = `${map.event}:${data.submission ?? crypto.createHash("sha256").update(JSON.stringify(p.body)).digest("hex").slice(0, 16)}`;
  p.emit(map.event, { ...data, app: p.manifest.name });
  /** @type {any} */ let flow = null;
  // No Flow answering that path yet is not an error: the event was said, and the person has not drawn the Flow.
  if (map.flow && p.startFlow) { try { flow = await p.startFlow(map.flow, { body: { ...data, app: p.manifest.name, event: map.event }, key, trust: "external" }); } catch (e) { if (/** @type {any} */ (e).code !== "not_found") throw e; } }
  return { event: map.event, ...(flow ? { flow: flow.run || true } : {}) };
}
/** A value as one safe part of a Drive path: letters, digits, space, dot, dash and underscore; nothing that climbs. @param {any} v */
const clean = v => String(v ?? "").replace(/[^A-Za-z0-9 _.-]+/g, "-").replace(/^[. -]+/, "").slice(0, 80) || "file";
/** The form the Connections module's create takes for an app module's `connection` block (IFACE-connection.md: `app` instead of a host; the key is the Vault item the install made). @param {any} m @param {string} vaultItem */
export function connectionForm(m, vaultItem) {
  const c = m.connection;
  const send = c.auth.kind === "header" || c.auth.kind === "query" ? { how: c.auth.kind, name: c.auth.name } : { how: c.auth.kind };
  return { label: c.label, app: m.name, send, credential: { item: vaultItem, field: "value" }, check: { path: c.check.path }, operations: c.operations || [] };
}
/** A dotted path with [n] indexes, into JSON. @param {any} o @param {string} at */
export function pick(o, at) {
  let v = o;
  for (const seg of at.split(".")) {
    const m = /^([A-Za-z0-9_]+)((?:\[\d+\])*)$/.exec(seg);
    if (!m || v == null) return undefined;
    v = v[m[1]];
    for (const i of m[2].matchAll(/\[(\d+)\]/g)) v = v == null ? undefined : v[Number(i[1])];
  }
  return v;
}

/** Tests put a fake driver here before the daemon starts; production leaves it null. */
export const seam = /** @type {{ driver: any }} */ ({ driver: null });

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    ctx.store.migrate(MIGRATIONS);
    const db = ctx.store.db;
    const catalog = loadCatalog(m => ctx.log.warn(m));
    // A server whose vyred has no Docker (the box) has its host helper start the app; anywhere else vyred reaches Docker itself.
    const driver = seam.driver || (hostHelperHere() ? createHelperDriver({ log: m => ctx.log.warn(m) }) : createDockerDirect({ home: ctx.paths.root, log: m => ctx.log.warn(m) }));
    const byHelper = driver.kind === "helper";
    const space = () => String((ctx.kernel && ctx.kernel.space) || "home");
    /** @type {Map<string, http.Server>} */ const listeners = new Map();
    const row = (/** @type {string} */ name) => db.prepare("SELECT * FROM appmods_apps WHERE name = ?").get(name);
    const item = (/** @type {string} */ name, /** @type {string} */ what) => `app-${name}-${what}`;
    const secret = async (/** @type {string} */ name, /** @type {string} */ what) => String(await ctx.vault.fetch(item(name, what), {}));
    const put = async (/** @type {string} */ name, /** @type {string} */ what, /** @type {string} */ value, /** @type {string} */ note) => {
      const r = await ctx.call("vault.put", { name: item(name, what), kind: "secret", description: `${note} (made by Vyre for the ${name} app)`, value, grants: ["appmods"] });
      if (r.error) throw refuse(`the Vault would not keep ${what}: ${r.error.message}`, r.error.code || "vault");
    };
    const secretsOf = async (/** @type {any} */ m) => Object.fromEntries(await Promise.all((m.app.secrets || []).map(async (/** @type {any} */ s) => [s.env, await secret(m.name, s.env.toLowerCase())])));
    const known = (/** @type {string} */ name) => { const m = catalog.get(String(name)); if (!m) throw refuse(`no app module called ${name}`, "not_found"); return m; };

    /** Webhooks from a docker-direct app arrive at a small listener on the app network's gateway (the daemon's own door is for apps that share the daemon's network). @param {any} m @param {string} host @param {number} port */
    function listen(m, host, port) {
      if (listeners.has(m.name)) return;
      const srv = http.createServer((req, res) => {
        const chunks = /** @type {Buffer[]} */ ([]);
        let size = 0;
        req.on("data", d => { size += d.length; if (size > 1_000_000) req.destroy(); else chunks.push(d); });
        req.on("end", async () => {
          let body = null;
          try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { res.writeHead(400).end(); return; }
          try {
            const out = await receive(m.name, String(req.headers["x-vyre-token"] || ""), body);
            res.writeHead(202, { "content-type": "application/json" }).end(JSON.stringify({ data: out }));
          } catch (e) { res.writeHead(/** @type {any} */ (e).code === "denied" ? 403 : 500).end(); }
        });
      });
      srv.on("error", e => ctx.log.warn(`appmods: the hook door of ${m.name} failed: ${e.message}`));
      srv.listen(port, host);
      listeners.set(m.name, srv);
    }
    async function receive(/** @type {string} */ name, /** @type {string} */ given, /** @type {any} */ body) {
      const m = known(name);
      if (!row(name)) throw refuse("that app is not installed", "not_found");
      const token = await secret(name, "hook");
      const origin = row(name).origin;
      const files = ctx.kernel && ctx.kernel.drive ? {
        // Only the path and query of the address the app printed are used, against the app's own origin: the app cannot send this module to another host.
        fetch: async (/** @type {string} */ url) => {
          let u; try { u = new URL(url); } catch { throw refuse("the app gave a document address that is not one", "bad_input"); }
          const r = await fetch(origin + u.pathname + u.search, { signal: AbortSignal.timeout(60_000) });
          if (!r.ok) throw refuse(`the app would not give the document (${r.status})`, "app_refused");
          const len = Number(r.headers.get("content-length") || 0);
          if (len > MAX_FILE) throw refuse("the document is bigger than 25 MB", "too_large");
          const bytes = new Uint8Array(await r.arrayBuffer());
          if (bytes.length > MAX_FILE) throw refuse("the document is bigger than 25 MB", "too_large");
          return bytes;
        },
        save: async (/** @type {string} */ to, /** @type {Uint8Array} */ bytes) => { await ctx.kernel.drive.put(ctx.kernel.serviceChain("appmods"), to, bytes); return { path: to, size: bytes.length }; },
      } : undefined;
      return handleWebhook({ manifest: m, token, given, body, files, emit: (t, p) => ctx.events.emit(t, p),
        startFlow: (p, o) => { const h = ctx.flowsHost && ctx.kernel && ctx.flowsHost.get(ctx.kernel.space); if (!h) throw refuse("Flows are not running here", "unavailable"); return h.flows.handleWeb(p, o); } });
    }

    async function healthy(/** @type {any} */ m, /** @type {string} */ origin) {
      const end = Date.now() + (m.app.health.startS || 120) * 1000;
      while (Date.now() < end) {
        try { const r = await fetch(origin + m.app.health.path, { redirect: "manual", signal: AbortSignal.timeout(5000) }); if (m.app.health.ok.includes(r.status)) return true; } catch { /* not yet */ }
        await new Promise(r => setTimeout(r, 1500));
      }
      throw refuse(`${m.name} did not become healthy in ${m.app.health.startS || 120} seconds`, "unhealthy");
    }

    // ---- reading
    ctx.tool("appmods.catalog", { description: "The apps this build can run as modules, each with its install card and whether it is installed here.", input: obj({}), run: async () => ({ apps: [...catalog.values()].map(m => ({ ...cardOf(m), installed: Boolean(row(m.name)) })) }) });
    ctx.tool("appmods.card", { description: "The install card for one app: what runs, what it uses, what it may reach, what it shows. Built from the manifest, never from the app.", input: obj({ name: str }, ["name"]), run: async (/** @type {any} */ i) => cardOf(known(i.name)) });
    ctx.tool("appmods.list", { description: "The app modules installed on this server and their state.", input: obj({}), run: async () => ({ apps: db.prepare("SELECT name, version, state, installed, note FROM appmods_apps ORDER BY name").all() }) });
    ctx.tool("appmods.status", { description: "One installed app: its state and what the runtime says.", input: obj({ name: str }, ["name"]), run: async (/** @type {any} */ i) => {
      const r = row(String(i.name)); if (!r) throw refuse("that app is not installed", "not_found");
      return { name: r.name, version: r.version, state: r.state, runtime: await driver.status({ space: r.space, manifest: known(r.name) }) };
    } });
    ctx.tool("appmods.screens", { description: "The screens installed apps add: [{ module, id, label, path, icon? }], path on the app's own origin (appmods.open makes the address). A screen of an app that is not running is not listed.", input: obj({}), run: async () => ({
      screens: db.prepare("SELECT name FROM appmods_apps WHERE state = 'running'").all().flatMap((/** @type {any} */ r) => (known(r.name).screens || []).map((/** @type {any} */ s) => ({ module: r.name, ...s }))) }) });
    ctx.tool("appmods.logs", { description: "The last lines an app wrote. For the person who owns this server.", input: obj({ name: str, lines: { type: "integer" } }, ["name"]), run: async (/** @type {any} */ i) => {
      const r = row(String(i.name)); if (!r) throw refuse("that app is not installed", "not_found");
      return { text: await driver.logs({ space: r.space, manifest: known(r.name) }, Math.min(Number(i.lines) || 100, 500)) };
    } });

    // ---- for the Connections module (team/0.3/IFACE-connection.md): where a running app is, and the Connection record its manifest declares.
    ctx.tool("appmods.origin", { description: "Where a running app is reached from this daemon: { origin }. For Vyre's own modules only (the Connections module calls it for a Connection made from an app).", input: obj({ name: str }, ["name"]), run: async (/** @type {any} */ i) => {
      const r = row(String(i.name)); if (!r || r.state !== "running" || !r.origin) throw refuse("that app is not running", "not_found");
      return { origin: r.origin };
    } });
    ctx.tool("appmods.connection", { description: "The Connection an installed app declares, in the Connection record's shape (label, auth, check, operations) with the Vault item that holds its key: { app, label, auth, credential: { item, field }, check, operations }.", input: obj({ name: str }, ["name"]), run: async (/** @type {any} */ i) => {
      const r = row(String(i.name)); if (!r) throw refuse("that app is not installed", "not_found");
      const c = known(r.name).connection; if (!c) throw refuse("that app declares no Connection", "not_found");
      return { app: r.name, label: c.label, auth: c.auth, credential: { item: item(r.name, c.credential.replace(/_/g, "-")), field: "value" }, check: c.check, operations: c.operations || [] };
    } });

    // ---- the owner's yes
    ctx.tool("appmods.install", {
      description: "Install an app module. The owner's yes: it makes the app's keys in the Vault, starts the container on this server, sets the app up and connects its events. Takes a minute or two.",
      input: obj({ name: str }, ["name"]),
      presence: { summary: async (/** @type {any} */ i) => `Install ${i && i.name} on this server` },
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
        const m = known(i.name);
        if (row(m.name)) throw refuse(`${m.name} is already installed`, "exists");
        const sp = space();
        // With the host helper, root makes the app's keys and the webhook key and hands the setup's outputs over once; the daemon keeps them in the Vault below.
        const secrets = /** @type {Record<string, string>} */ ({});
        const hookPort = byHelper ? driver.hookPortFor(m) : await freePort("127.0.0.1");
        const hookToken = gen("hex32");
        if (!byHelper) {
          for (const s of m.app.secrets || []) { secrets[s.env] = gen(s.generate); await put(m.name, s.env.toLowerCase(), secrets[s.env], s.env); }
          await put(m.name, "hook", hookToken, "the key the app's webhooks carry");
        }
        db.prepare("INSERT INTO appmods_apps (name, space, version, state, origin, hook_port, login_email, installed, note) VALUES (?,?,?,?,?,?,?,?,?)").run(m.name, sp, m.version, "installing", null, hookPort, `vyre+${m.name}@vyre.invalid`, Date.now(), "");
        try {
          const up = await driver.up({ space: sp, manifest: m, vars: { name: m.name, origin: originFor(m.name, baseHost()) }, secrets, hookPort });
          db.prepare("UPDATE appmods_apps SET origin = ? WHERE name = ?").run(up.origin, m.name);
          await healthy(m, up.origin);
          listen(m, up.hookHost, hookPort);
          if (byHelper) {
            const got = up.outputs || {};
            if (m.app.bootstrap && !got.hook_token) throw refuse(`setting ${m.name} up gave no hand-over`, "bootstrap");
            if (got.hook_token) await put(m.name, "hook", got.hook_token, "the key the app's webhooks carry");
            for (const o of (m.app.bootstrap || {}).outputs || []) {
              if (!got[o.name]) throw refuse(`setting ${m.name} up gave no ${o.name}`, "bootstrap");
              await put(m.name, o.name.replace(/_/g, "-"), got[o.name], o.name);
            }
          } else if (m.app.bootstrap) {
            const out = await driver.exec({ space: sp, manifest: m }, [...m.app.bootstrap.exec, "{file}"], {
              env: { APP_URL: originFor(m.name, baseHost()), VYRE_LOGIN_EMAIL: `vyre+${m.name}@vyre.invalid`, VYRE_HOOK_URL: `http://${up.hookHost}:${hookPort}/hook`, VYRE_HOOK_TOKEN: hookToken },
              files: [{ name: m.app.bootstrap.script, text: bootstrapScript(m) }],
            });
            if (out.code !== 0) throw refuse(`setting ${m.name} up failed: ${out.stderr.trim().split("\n").filter(l => !/not writable|Bundler will use|Changing the owner|Unable to/.test(l)).slice(0, 4).join(" ").replace(/\s+/g, " ").slice(0, 400)}`, "bootstrap");
            const lines = Object.fromEntries(out.stdout.split("\n").map(l => /^([a-z][a-z0-9_]*)=(.+)$/.exec(l.trim())).filter(Boolean).map(x => [/** @type {RegExpExecArray} */ (x)[1], /** @type {RegExpExecArray} */ (x)[2]]));
            for (const o of m.app.bootstrap.outputs) {
              if (!lines[o.name]) throw refuse(`setting ${m.name} up gave no ${o.name}`, "bootstrap");
              await put(m.name, o.name.replace(/_/g, "-"), lines[o.name], o.name);
            }
          }
          db.prepare("UPDATE appmods_apps SET state = 'running' WHERE name = ?").run(m.name);
          // The app's own API as a Connection (team/0.3/IFACE-connection.md): the person's act relays through the Connections module, so agents and Flows use the app like any Connection. A build without the
          // Connections module (or without the app-origin form) installs the app all the same and says so.
          let connection = null;
          if (m.connection) {
            try {
              const form = connectionForm(m, item(m.name, m.connection.credential.replace(/_/g, "-")));
              const made = await ctx.call("connectors.connection.create", form, { as: meta && meta.caller });
              if (made.error) throw new Error(made.error.message);
              connection = made.data && made.data.id ? String(made.data.id) : null;
              if (connection) db.prepare("UPDATE appmods_apps SET connection_id = ? WHERE name = ?").run(connection, m.name);
            } catch (e) { ctx.log.warn(`appmods: ${m.name} is installed without its Connection: ${/** @type {Error} */ (e).message}`); db.prepare("UPDATE appmods_apps SET note = ? WHERE name = ?").run(`no Connection yet: ${String(/** @type {Error} */ (e).message).slice(0, 200)}`, m.name); }
          }
          // The Kit the app ships (its record type and its Flow), proposed as the installing person: the owner's yes in Now is what defines it. A build without Flows installs the app all the same.
          let kit = null;
          if (m.kit) {
            try {
              const stored = JSON.parse(fs.readFileSync(path.join(CATALOG, m.kit), "utf8"));
              const made = await ctx.call("flows.kit.propose", { kit: stored }, { relay: true });
              if (made.error) throw new Error(made.error.message);
              kit = made.data && made.data.task ? String(made.data.task) : "proposed";
              db.prepare("UPDATE appmods_apps SET kit_task = ? WHERE name = ?").run(kit, m.name);
            } catch (e) { ctx.log.warn(`appmods: ${m.name} is installed without its Kit: ${/** @type {Error} */ (e).message}`); }
          }
          ctx.events.emit("appmods.installed", { name: m.name, version: m.version });
          return { name: m.name, state: "running", connection, kit };
        } catch (e) {
          db.prepare("UPDATE appmods_apps SET state = 'failed', note = ? WHERE name = ?").run(String(/** @type {Error} */ (e).message).slice(0, 300), m.name);
          throw e;
        }
      },
    });
    ctx.tool("appmods.start", { description: "Start an installed app again.", input: obj({ name: str }, ["name"]), run: async (/** @type {any} */ i) => {
      const r = row(String(i.name)); if (!r) throw refuse("that app is not installed", "not_found");
      const m = known(r.name);
      const up = await driver.up({ space: r.space, manifest: m, vars: { name: m.name, origin: originFor(m.name, baseHost()) }, secrets: byHelper ? {} : await secretsOf(m), hookPort: r.hook_port });
      db.prepare("UPDATE appmods_apps SET state = 'running', origin = ? WHERE name = ?").run(up.origin, m.name);
      listen(m, up.hookHost, r.hook_port);
      ctx.events.emit("appmods.started", { name: m.name });
      return { name: m.name, state: "running" };
    } });
    ctx.tool("appmods.stop", { description: "Stop an installed app. Its data stays.", input: obj({ name: str }, ["name"]), run: async (/** @type {any} */ i) => {
      const r = row(String(i.name)); if (!r) throw refuse("that app is not installed", "not_found");
      await driver.stop({ space: r.space, manifest: known(r.name) });
      db.prepare("UPDATE appmods_apps SET state = 'stopped' WHERE name = ?").run(r.name);
      tickets.drop(r.name);
      ctx.events.emit("appmods.stopped", { name: r.name });
      return { name: r.name, state: "stopped" };
    } });
    ctx.tool("appmods.remove", {
      description: "Remove an installed app: the container and its network. Its data stays unless you say data: true.",
      input: obj({ name: str, data: { type: "boolean" } }, ["name"]),
      presence: { summary: async (/** @type {any} */ i) => `Remove ${i && i.name} from this server${i && i.data ? " and delete its data" : ""}` },
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
        const r = row(String(i.name)); if (!r) throw refuse("that app is not installed", "not_found");
        if (r.connection_id) await ctx.call("connectors.connection.delete", { id: r.connection_id }, { as: meta && meta.caller }).catch(() => {});
        await driver.down({ space: r.space, manifest: known(r.name), hookPort: r.hook_port }, { data: i.data === true });
        const l = listeners.get(r.name); if (l) { l.close(); listeners.delete(r.name); }
        db.prepare("DELETE FROM appmods_apps WHERE name = ?").run(r.name);
        tickets.drop(r.name);
        for (const what of ["hook", ...(known(r.name).app.secrets || []).map((/** @type {any} */ s) => s.env.toLowerCase()), ...((known(r.name).app.bootstrap || {}).outputs || []).map((/** @type {any} */ o) => o.name.replace(/_/g, "-"))]) await ctx.call("vault.delete", { name: item(r.name, what) }).catch(() => {});
        ctx.events.emit("appmods.removed", { name: r.name });
        return { name: r.name, removed: true };
      },
    });

    // The daemon's hook door (POST /v1/appmods/<name>/hook) for apps that share the daemon's network; the token rides in x-vyre-token.
    ctx.tool("appmods.hook", { description: "An app's webhook, from the daemon's hook door. Checks the app's token.", input: obj({ name: str, token: str, body: { type: "object", additionalProperties: true } }, ["name"]), run: async (/** @type {any} */ i) => receive(String(i.name), String(i.token || ""), i.body) });

    // The apps' own screens, each on its own origin (<module>.<base>), answered by Host before any Vyre route (proxy.js). Only an installed app that is running is served.
    const tickets = createTickets();
    // The look a public signing page takes from the space's brand (core/brand): the profile resolved into a stylesheet, or nothing when there is no brand or no brand module.
    const brandCss = async () => {
      try { const r = await ctx.call("brand.resolve", {}); return r && !r.error && r.data ? signingBrand(r.data) : ""; } catch { return ""; }
    };
    const hostProxy = createHostProxy({
      brand: brandCss,
      tickets,
      log: m => ctx.log.warn(m),
      app: async name => {
        const r = row(String(name));
        if (!r || r.state !== "running" || !r.origin) return null;
        const m = catalog.get(r.name);
        if (!m) return null;
        return { origin: r.origin, origins: [r.origin, "http://localhost:3000"], login: m.app.login || null, public: m.app.public || [], ...(m.app.signing ? { signing: m.app.signing } : {}),
          credentials: async () => ({ login_email: r.login_email, login_password: await secret(r.name, "login-password") }) };
      },
    });
    // The apps' front: a listener on this machine's loopback of its own (config appmods.listen, else any free port) that answers requests by Host and nothing else. The public gate carries
    // `<module>.<name>.vyre.run` to it (ingress `apps`); a request that is not an installed running app's host is a plain 404 here, so Vyre's own routes are not on this port at all.
    const front = http.createServer((req, res) => {
      let url; try { url = new URL(req.url || "/", "http://x"); } catch { res.writeHead(400).end(); return; }
      hostProxy(req, res, { url }).then(done => { if (!done && !res.headersSent) { res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }); res.end("not found"); } }).catch(() => { if (!res.headersSent) res.writeHead(502); res.end(); });
    });
    front.on("error", e => ctx.log.warn(`appmods: the apps' front could not listen: ${e.message}`));
    await new Promise(r => { front.once("listening", r); front.once("error", r); front.listen(Number((ctx.config.appmods || {}).listen) || 0, "127.0.0.1"); });
    ctx.tool("appmods.front", { description: "The loopback port the apps' front listens on: { port }. For Vyre's own modules (the public gate carries the apps' hosts to it).", input: obj({}), run: async () => {
      const a = front.address(); if (!a || typeof a === "string") throw refuse("the apps' front is not listening", "unavailable"); return { port: a.port };
    } });
    /** The host Vyre is served at, which the apps' hosts hang from: config appmods.base, else <the box's name>.vyre.run, else localhost. */
    const baseHost = () => {
      const c = ctx.config || {};
      const given = c.appmods && typeof c.appmods.base === "string" ? c.appmods.base : "";
      if (/^[a-z0-9.-]+(?::\d{1,5})?$/i.test(given)) return given.toLowerCase();
      const n = c.network && c.network.name;
      return typeof n === "string" && /^[a-z][a-z0-9-]{1,30}$/.test(n) ? `${n}.vyre.run` : "localhost";
    };
    /** Is this call from the Space's owner or an admin? An app has one signed-in user in the app (the install's), so for now only they may open it. @param {any} meta */
    const ownerOrAdmin = async meta => {
      if (!ctx.kernel || typeof ctx.kernel.chain !== "function") throw refuse("this build runs without its kernel", "unavailable");
      const chain = await ctx.kernel.chain(meta).catch(() => null);
      const hop = chain && Array.isArray(chain.hops) ? chain.hops[0] : null;
      if (!hop || !hop.actor || hop.actor.kind !== "person" || chain.hops.length !== 1) return false;
      if (hop.actor.id === ctx.kernel.owner) return true;
      const mem = await ctx.kernel.grants.members.get(chain, hop.actor.id).catch(() => null);
      return Boolean(mem && (mem.role === "owner" || mem.role === "admin"));
    };
    ctx.tool("appmods.open", {
      description: "Open an installed app's screen: answers { url }, an address on the app's own origin that carries a one-time ticket good for a minute. Open it in the main pane or a browser tab; the app is already signed in. For the Space's owner and admins. `origin` is the address Vyre itself is open at (its host decides the app's host).",
      input: obj({ name: str, screen: str, origin: str }, ["name"]),
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
        const r = row(String(i.name)); if (!r || r.state !== "running") throw refuse("that app is not running", "not_found");
        if (!(await ownerOrAdmin(meta))) throw refuse("only the owner or an admin of this Space opens this app", "denied");
        const m = known(r.name);
        const screen = (m.screens || []).find((/** @type {any} */ s) => s.id === i.screen) || (m.screens || [])[0];
        let base = baseHost();
        if (typeof i.origin === "string" && i.origin) { try { const u = new URL(i.origin); if (/^[a-z0-9.-]+$/i.test(u.hostname)) base = u.host.toLowerCase(); } catch { /* the configured base */ } }
        const here = originFor(r.name, base);
        const t = tickets.issue(r.name, new URL(here).host, screen ? screen.path : "/");
        return { url: `${here}${ENTER}?t=${t}`, host: new URL(here).host };
      },
    });
    ctx.tool("appmods.hosts", { description: "The host names the installed apps need served (one per app): the front door's certificate and name must cover them.", input: obj({}), run: async () => ({
      hosts: db.prepare("SELECT name FROM appmods_apps WHERE state = 'running'").all().map((/** @type {any} */ r) => new URL(originFor(r.name, baseHost())).host) }) });

    // Apps that were running when this daemon stopped come back with it.
    for (const r of db.prepare("SELECT * FROM appmods_apps WHERE state = 'running'").all()) {
      (byHelper ? Promise.resolve({}) : secretsOf(known(r.name))).then((/** @type {any} */ secrets) => driver.up({ space: r.space, manifest: known(r.name), vars: { name: r.name, origin: originFor(r.name, baseHost()) }, secrets, hookPort: r.hook_port }))
        .then((/** @type {any} */ up) => { db.prepare("UPDATE appmods_apps SET origin = ? WHERE name = ?").run(up.origin, r.name); listen(known(r.name), up.hookHost, r.hook_port); })
        .catch((/** @type {Error} */ e) => ctx.log.warn(`appmods: ${r.name} did not come back: ${e.message}`));
    }
    return { async stop() { for (const s of listeners.values()) s.close(); listeners.clear(); front.close(); } };
  },
};
