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
import { DOMAIN_MIGRATIONS, createDomains, ownOrigin } from "./domains.js";
import { registerDomainTools } from "./domain-tools.js";
import { signingBrand } from "../../lib/brand/profile.js";
import { publishedManifest, checkPublished } from "./published.js";
import { mintLink, SIGNED, MAX_LINK_DAYS, requestBody, readRequest, readWaiting } from "./signing.js";

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
  // Servers Publish made from a built image (team/contracts/builder.md): the manifest it was made with, the deployment it belongs to and the Space whose publish folder holds its secrets.
  `CREATE TABLE appmods_published (name TEXT PRIMARY KEY, deployment TEXT NOT NULL, space TEXT NOT NULL, manifest TEXT NOT NULL);`,
  // Signed-in browser sessions on an app's own origin (and a preview's): kept by the hash of the cookie so a restart or an update does not sign anyone out.
  `CREATE TABLE appmods_sessions (h TEXT PRIMARY KEY, name TEXT NOT NULL, host TEXT NOT NULL, exp INTEGER NOT NULL, who_w TEXT, who_r TEXT);`,
  // the key an app's expiring links to a signed copy are made under; it never leaves the box
  `CREATE TABLE appmods_link_keys (name TEXT PRIMARY KEY, key BLOB NOT NULL);`,
  ...DOMAIN_MIGRATIONS,
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
  if (!p.given || !sameToken(String(p.given), p.token)) throw refuse("that is not the app's token: check the webhook address the app was given", "denied");
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
export const seam = /** @type {{ driver: any, rotateMs?: number }} */ ({ driver: null });

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
/** A preview's name on the front: pv- and eight hex digits. Never an installed app's name (those are catalog names). */
const PREVIEW_NAME = /^pv-[0-9a-f]{8}$/;

export default {
  async start(ctx) {
    ctx.store.migrate(MIGRATIONS);
    const db = ctx.store.db;
    const catalog = loadCatalog(m => ctx.log.warn(m));
    // A server whose vyred has no Docker (the box) has its host helper start the app; anywhere else vyred reaches Docker itself.
    const driver = seam.driver || (hostHelperHere() ? createHelperDriver({ home: ctx.paths.root, log: m => ctx.log.warn(m) }) : createDockerDirect({ home: ctx.paths.root, log: m => ctx.log.warn(m) }));
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
    /** The runtime secrets of a published server: the files Publish wrote from the Vault (its own grants), in the deployment's folder under the publish folder of its Space. The folder is derived here, never taken from a call. */
    const publishedSecrets = (/** @type {any} */ m) => {
      const pub = db.prepare("SELECT * FROM appmods_published WHERE name = ?").get(m.name);
      /** @type {Record<string, string>} */ const out = {};
      for (const n of m["x-publish"].secrets || []) {
        const file = path.join(ctx.paths.root, "publish", String(pub && pub.space), "secrets", String(m["x-publish"].deployment), n);
        let v; try { v = fs.readFileSync(file, "utf8"); } catch { throw refuse(`the secret ${n} is not granted to this site yet: give it from the site's secrets, then publish again`, "no_secret"); }
        out[n] = v;
      }
      return out;
    };
    const secretsOf = async (/** @type {any} */ m) => m["x-publish"] ? publishedSecrets(m) : Object.fromEntries(await Promise.all((m.app.secrets || []).map(async (/** @type {any} */ s) => [s.env, await secret(m.name, s.env.toLowerCase())])));
    // The servers Publish made keep their manifests in the database and are known like any app from here on.
    for (const r of /** @type {any[]} */ (db.prepare("SELECT * FROM appmods_published").all())) {
      try { if (catalog.has(r.name)) { ctx.log.warn(`appmods: the published server ${r.name} has the name of an app that ships with Vyre and is not loaded`); continue; } catalog.set(r.name, JSON.parse(r.manifest)); } catch { /* an unreadable row is left out */ }
    }
    /** The Space a published server's files and secrets are kept under (for the helper driver). @param {any} m */
    const pubSpaceOf = m => { if (!m || !m["x-publish"]) return {}; const p = /** @type {any} */ (db.prepare("SELECT space FROM appmods_published WHERE name = ?").get(m.name)); return p ? { publishSpace: String(p.space) } : {}; };
    const known = (/** @type {string} */ name) => { const m = catalog.get(String(name)); if (!m) throw refuse(`no app module called ${name} (appmods.catalog lists the apps this build can run)`, "not_found"); return m; };

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
      if (!row(name)) throw refuse("that app is not installed (appmods.list shows the installed ones, appmods.install adds one)", "not_found");
      const token = await secret(name, "hook");
      const origin = row(name).origin;
      const files = ctx.kernel && ctx.kernel.drive ? {
        // Only the path and query of the address the app printed are used, against the app's own origin: the app cannot send this module to another host.
        fetch: async (/** @type {string} */ url) => {
          let u; try { u = new URL(url); } catch { throw refuse("the app gave a document address that is not one", "bad_input"); }
          const r = await fetch(origin + u.pathname + u.search, { signal: AbortSignal.timeout(60_000) });
          if (!r.ok) throw refuse(`the app would not give the document (${r.status})`, "app_refused");
          const len = Number(r.headers.get("content-length") || 0);
          if (len > MAX_FILE) throw refuse("the document is bigger than 25 MB: make it smaller and send it again", "too_large");
          const bytes = new Uint8Array(await r.arrayBuffer());
          if (bytes.length > MAX_FILE) throw refuse("the document is bigger than 25 MB: make it smaller and send it again", "too_large");
          return bytes;
        },
        save: async (/** @type {string} */ to, /** @type {Uint8Array} */ bytes) => { await ctx.kernel.drive.put(ctx.kernel.serviceChain("appmods"), to, bytes); return { path: to, size: bytes.length }; },
      } : undefined;
      return handleWebhook({ manifest: m, token, given, body, files, emit: (t, p) => ctx.events.emit(t, p),
        startFlow: (p, o) => { const h = ctx.flowsHost && ctx.kernel && ctx.flowsHost.get(ctx.kernel.space); if (!h) throw refuse("Flows are not running here: ask the owner or an admin to turn them on", "unavailable"); return h.flows.handleWeb(p, o); } });
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
    ctx.tool("appmods.catalog", { description: "The apps this build can run as modules, each with its install card and whether it is installed here.", input: obj({}), run: async () => ({ apps: [...catalog.values()].filter(m => !m["x-publish"]).map(m => ({ ...cardOf(m), installed: Boolean(row(m.name)) })) }) });
    ctx.tool("appmods.card", { description: "The install card for one app: what runs, what it uses, what it may reach, what it shows. Built from the manifest, not the app.", input: obj({ name: str }, ["name"]), run: async (/** @type {any} */ i) => cardOf(known(i.name)) });
    ctx.tool("appmods.list", { description: "The app modules installed on this server and their state.", input: obj({}), run: async () => ({ apps: db.prepare("SELECT name, version, state, installed, note FROM appmods_apps ORDER BY name").all() }) });
    ctx.tool("appmods.status", { description: "One installed app: its state and what the runtime says.", input: obj({ name: str }, ["name"]), run: async (/** @type {any} */ i) => {
      const r = row(String(i.name)); if (!r) throw refuse("that app is not installed (appmods.list shows the installed ones, appmods.install adds one)", "not_found");
      return { name: r.name, version: r.version, state: r.state, runtime: await driver.status({ space: r.space, manifest: known(r.name) }) };
    } });
    ctx.tool("appmods.screens", { description: "List screens of running installed apps as [{ module, id, label, path, icon? }]; appmods.open makes the address from path.", input: obj({}), run: async () => ({
      screens: db.prepare("SELECT name FROM appmods_apps WHERE state = 'running'").all().flatMap((/** @type {any} */ r) => (known(r.name).screens || []).map((/** @type {any} */ s) => ({ module: r.name, ...s }))) }) });
    ctx.tool("appmods.logs", { description: "The last lines an app wrote. For the person who owns this server.", input: obj({ name: str, lines: { type: "integer" } }, ["name"]), run: async (/** @type {any} */ i) => {
      const r = row(String(i.name)); if (!r) throw refuse("that app is not installed (appmods.list shows the installed ones, appmods.install adds one)", "not_found");
      return { text: await driver.logs({ space: r.space, manifest: known(r.name) }, Math.min(Number(i.lines) || 100, 500)) };
    } });

    // ---- for the Connections module (team/0.3/IFACE-connection.md): where a running app is, and the Connection record its manifest declares.
    ctx.tool("appmods.origin", { description: "Where a running app is reached from this daemon: { origin }. For Vyre's own modules only (the Connections module calls it for a Connection made from an app).", input: obj({ name: str }, ["name"]), run: async (/** @type {any} */ i) => {
      const r = row(String(i.name)); if (!r || r.state !== "running" || !r.origin) throw refuse("that app is not running (appmods.status shows its state, appmods.start starts it)", "not_found");
      return { origin: r.origin };
    } });
    ctx.tool("appmods.connection", { description: "The Connection an installed app declares, as { app, label, auth, credential: { item, field }, check, operations }, with its Vault item.", input: obj({ name: str }, ["name"]), run: async (/** @type {any} */ i) => {
      const r = row(String(i.name)); if (!r) throw refuse("that app is not installed (appmods.list shows the installed ones, appmods.install adds one)", "not_found");
      const c = known(r.name).connection; if (!c) throw refuse("that app declares no Connection (connectors.connection.propose proposes one by hand)", "not_found");
      return { app: r.name, label: c.label, auth: c.auth, credential: { item: item(r.name, c.credential.replace(/_/g, "-")), field: "value" }, check: c.check, operations: c.operations || [] };
    } });

    // ---- the owner's yes
    ctx.tool("appmods.install", {
      description: "Install an app module. The owner's yes: it makes the app's keys in the Vault, starts the container on this server, sets the app up and connects its events. Takes a minute or two.",
      input: obj({ name: str }, ["name"]),
      presence: { summary: async (/** @type {any} */ i) => `Install ${i && i.name} on this server` },
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
        const m = known(i.name);
        if (m["x-publish"]) throw refuse(`${m.name} is a site Publish runs; publish it again to change it`, "unsupported");
        if (row(m.name)) throw refuse(`${m.name} is already installed (appmods.status shows how it is doing)`, "exists");
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
      const r = row(String(i.name)); if (!r) throw refuse("that app is not installed (appmods.list shows the installed ones, appmods.install adds one)", "not_found");
      const m = known(r.name);
      const up = await driver.up({ space: r.space, manifest: m, vars: { name: m.name, origin: originFor(m.name, baseHost()) }, secrets: byHelper && !m["x-publish"] ? {} : await secretsOf(m), hookPort: r.hook_port, ...pubSpaceOf(m) });
      db.prepare("UPDATE appmods_apps SET state = 'running', origin = ? WHERE name = ?").run(up.origin, m.name);
      if (!m["x-publish"]) listen(m, up.hookHost, r.hook_port);
      ctx.events.emit("appmods.started", { name: m.name });
      return { name: m.name, state: "running" };
    } });
    ctx.tool("appmods.stop", { description: "Stop an installed app. Its data stays.", input: obj({ name: str }, ["name"]), run: async (/** @type {any} */ i) => {
      const r = row(String(i.name)); if (!r) throw refuse("that app is not installed (appmods.list shows the installed ones, appmods.install adds one)", "not_found");
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
        const r = row(String(i.name)); if (!r) throw refuse("that app is not installed (appmods.list shows the installed ones, appmods.install adds one)", "not_found");
        if (known(r.name)["x-publish"]) throw refuse(`${r.name} is a site Publish runs; retire it in Publish`, "unsupported");
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

    // A key rotated in the Vault reaches the app (R031-73): the container is made again with the new value and its data stays. A burst of changes (two keys rotated together) is one restart, and an app the host
    // helper runs has its keys made by root, so those are not this module's to change.
    /** @type {Map<string, NodeJS.Timeout>} */ const rotating = new Map();
    const rotate = async (/** @type {any} */ r) => {
      const m = known(r.name), p = { space: r.space, manifest: m, hookPort: r.hook_port };
      await driver.down(p, { data: false });
      const up = await driver.up({ ...p, vars: { name: m.name, origin: originFor(m.name, baseHost()) }, secrets: await secretsOf(m) });
      db.prepare("UPDATE appmods_apps SET state = 'running', origin = ? WHERE name = ?").run(up.origin, m.name);
      listen(m, up.hookHost, r.hook_port);
      ctx.events.emit("appmods.restarted", { name: m.name, why: "a key changed in the Vault" });
    };
    const offRotate = ctx.events.on("vault.item-changed", (/** @type {any} */ e) => {
      const changed = String((e.payload || e).name || "");
      if (byHelper || !changed.startsWith("app-")) return;
      for (const r of /** @type {any[]} */ (db.prepare("SELECT * FROM appmods_apps WHERE state = 'running'").all())) {
        const m = catalog.get(String(r.name));
        if (!m || !(m.app.secrets || []).some((/** @type {any} */ s) => item(r.name, s.env.toLowerCase()) === changed) || rotating.has(r.name)) continue;
        rotating.set(r.name, setTimeout(() => {
          rotating.delete(r.name);
          // The container is gone before the new one starts: if it does not start, the app is stopped, not "running" in the list, and the person can start it again.
          rotate(r).catch(err => { db.prepare("UPDATE appmods_apps SET state = 'stopped' WHERE name = ?").run(r.name); tickets.drop(r.name); ctx.events.emit("appmods.stopped", { name: r.name }); ctx.log.warn(`appmods: ${r.name} did not restart with its new key: ${err.message}`); });
        }, seam.rotateMs ?? 300));
      }
    });

    // The daemon's hook door (POST /v1/appmods/<name>/hook) for apps that share the daemon's network; the token rides in x-vyre-token.
    ctx.tool("appmods.hook", { description: "An app's webhook, from the daemon's hook door. Checks the app's token.", input: obj({ name: str, token: str, body: { type: "object", additionalProperties: true } }, ["name"]), run: async (/** @type {any} */ i) => receive(String(i.name), String(i.token || ""), i.body) });

    // The apps' own screens, each on its own origin (<module>.<base>), answered by Host before any Vyre route (proxy.js). Only an installed app that is running is served.
    const tickets = createTickets({ store: {
      put: (/** @type {string} */ h, /** @type {any} */ r) => { db.prepare("INSERT OR REPLACE INTO appmods_sessions (h, name, host, exp, who_w, who_r) VALUES (?,?,?,?,?,?)").run(h, r.name, r.host, r.exp, r.who ? r.who.w : null, r.who ? r.who.r : null); },
      get: (/** @type {string} */ h) => { const r = db.prepare("SELECT * FROM appmods_sessions WHERE h = ?").get(h); return r ? { name: r.name, host: r.host, exp: Number(r.exp), who: r.who_w ? { w: r.who_w, r: r.who_r || "" } : null } : null; },
      dropName: (/** @type {string} */ n) => { db.prepare("DELETE FROM appmods_sessions WHERE name = ?").run(n); },
      sweep: (/** @type {number} */ t) => { db.prepare("DELETE FROM appmods_sessions WHERE exp < ?").run(t); },
    } });
    // The look a public signing page takes from the space's brand (core/brand): the profile resolved into a stylesheet, or nothing when there is no brand or no brand module.
    const brandCss = async () => {
      try { const r = await ctx.call("brand.resolve", {}); return r && !r.error && r.data ? signingBrand(r.data) : ""; } catch { return ""; }
    };
    /** The key an app's signed-copy links are made under: made once, kept in the box's own store. @param {string} name */
    const linkKey = name => {
      const have = /** @type {any} */ (db.prepare("SELECT key FROM appmods_link_keys WHERE name = ?").get(name));
      if (have) return Buffer.from(have.key);
      const key = crypto.randomBytes(32);
      db.prepare("INSERT OR IGNORE INTO appmods_link_keys (name, key) VALUES (?, ?)").run(name, key);
      return Buffer.from(/** @type {any} */ (db.prepare("SELECT key FROM appmods_link_keys WHERE name = ?").get(name)).key);
    };
    const domains = createDomains(db);
    const hostProxy = createHostProxy({
      alias: host => domains.appOf(host),
      brand: brandCss,
      linkKey,
      tickets,
      log: m => ctx.log.warn(m),
      app: async name => {
        // A preview (core/previews) is one more origin behind the same front, ticket and cookie: asked of that module by name, never by import.
        if (PREVIEW_NAME.test(String(name))) {
          const p = await ctx.call("previews.resolve", { name: String(name) }).catch(() => null);
          return p && p.data && p.data.origin ? { origin: p.data.origin, origins: [p.data.origin], login: null, public: [], rewriteHost: true, passCookies: true, allowEmbed: true, ...(typeof p.data.viewerKey === "string" ? { viewerKey: p.data.viewerKey, viewerScope: String(name) } : {}), credentials: async () => ({}) } : null;
        }
        const r = row(String(name));
        if (!r || r.state !== "running" || !r.origin) return null;
        const m = catalog.get(r.name);
        if (!m || m.app.service) return null;
        // A server Publish made keeps its own cookies (the proxy removes only Vyre's) and, once it is live, answers strangers on every route; it never signs in to anything
        if (m["x-publish"]) return { origin: r.origin, origins: [r.origin], login: null, public: [], passCookies: true, ...(m.app.open ? { open: true } : {}), credentials: async () => ({}) };
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
    // A WebSocket on an app's origin (a preview's hot reload): the same checks, tunnelled.
    front.on("upgrade", (req, socket, head) => { hostProxy.upgrade(req, /** @type {any} */ (socket), head).then(done => { if (!done) socket.destroy(); }).catch(() => socket.destroy()); });
    await new Promise(r => { front.once("listening", r); front.once("error", r); front.listen(Number((ctx.config.appmods || {}).listen) || 0, "127.0.0.1"); });
    ctx.tool("appmods.front", { description: "The loopback port the apps' front listens on: { port }. For Vyre's own modules (the public gate carries the apps' hosts to it).", input: obj({}), run: async () => {
      const a = front.address(); if (!a || typeof a === "string") throw refuse("the apps' front is not listening: wait a minute and call again, then ask the owner of this server", "unavailable"); return { port: a.port };
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
      if (!ctx.kernel || typeof ctx.kernel.chain !== "function") throw refuse("this build runs without its kernel: ask the owner of this server to run a build that has one", "unavailable");
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
        const r = row(String(i.name)); if (!r || r.state !== "running") throw refuse("that app is not running (appmods.status shows its state, appmods.start starts it)", "not_found");
        if (!(await ownerOrAdmin(meta))) throw refuse("only the owner or an admin of this Space opens this app", "denied");
        const m = known(r.name);
        if (m.app.service) throw refuse(`${r.name} is a service other modules use; it has no screen to open`, "unsupported");
        const screen = (m.screens || []).find((/** @type {any} */ s) => s.id === i.screen) || (m.screens || [])[0];
        let base = baseHost();
        if (typeof i.origin === "string" && i.origin) { try { const u = new URL(i.origin); if (/^[a-z0-9.-]+$/i.test(u.hostname)) base = u.host.toLowerCase(); } catch { /* the configured base */ } }
        const here = originFor(r.name, base);
        const t = tickets.issue(r.name, new URL(here).host, screen ? screen.path : "/");
        return { url: `${here}${ENTER}?t=${t}`, host: new URL(here).host };
      },
    });
    // The previews module's door onto the same ticket path: it has judged who may open a preview, and asks for the ticket address. Modules only, and only for a preview's own name.
    const previewsOnly = (/** @type {any} */ meta, /** @type {string} */ name) => {
      if (!meta || meta.caller !== "module:previews" || meta.firstParty === false) throw refuse("the previews module alone asks for a preview's ticket: open the preview through the previews module", "denied");
      if (!PREVIEW_NAME.test(String(name))) throw refuse("that is not a preview's name", "bad_input");
    };
    ctx.tool("appmods.ticket", {
      description: "A one-time sign-in address for a preview, on its own origin: { url, host }. Internal: the previews module has already decided that this person may open it.", internal: true,
      input: obj({ name: str, next: str, origin: str, who: str, role: str, embed: { type: "boolean" } }, ["name"]),
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
        previewsOnly(meta, i.name);
        let base = baseHost();
        if (typeof i.origin === "string" && i.origin) { try { const u = new URL(i.origin); if (/^[a-z0-9.-]+$/i.test(u.hostname)) base = u.host.toLowerCase(); } catch { /* the configured base */ } }
        const here = originFor(i.name, base);
        const next = typeof i.next === "string" && i.next.startsWith("/") && !i.next.startsWith("//") ? i.next : "/";
        const who = typeof i.who === "string" && i.who ? { w: String(i.who).slice(0, 120), r: String(i.role || "").slice(0, 20) } : null;
        return { url: `${here}${ENTER}?t=${tickets.issue(i.name, new URL(here).host, next, who, i.embed === true)}`, host: new URL(here).host };
      },
    });
    ctx.tool("appmods.drop", {
      description: "End every open sign-in to a preview (its access changed, or it was removed). Internal: the previews module only.", internal: true,
      input: obj({ name: str }, ["name"]),
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => { previewsOnly(meta, i.name); tickets.drop(i.name); return { dropped: i.name }; },
    });
    ctx.tool("appmods.signed.link", {
      internal: true, callers: ["module"],
      description: "A link to the signed copy of one finished document on an app's own address: { name, slug, days? (1 to 3650; left out, the link does not expire) } -> { url, expires } (expires is null for a link with no end). Only the app's own module asks (documents for Documents); the link opens the finished file and nothing else. appmods.signed.revoke ends every link made so far.",
      input: obj({ name: str, slug: str, days: { type: "integer" } }, ["name", "slug"]),
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
        const name = String(i.name || "");
        if (!meta || meta.caller !== `module:${name}`) throw refuse("only the app's own module makes a link to its signed copies", "denied");
        const r = row(name); if (!r || r.state !== "running") throw refuse("that app is not running (appmods.status shows its state, appmods.start starts it)", "not_found");
        const m = known(name);
        if (!(m.app && m.app.signing && m.app.signing.signed)) throw refuse("that app has no signed copies to link (documents.send gets a document signed first)", "unsupported");
        const days = i.days === undefined || i.days === null ? null : i.days;
        if (days !== null && (!Number.isInteger(days) || days < 1 || days > MAX_LINK_DAYS)) throw refuse(`a link lasts 1 to ${MAX_LINK_DAYS} days, or does not expire`, "bad_input");
        const expires = days === null ? null : Date.now() + days * 86_400_000;
        let token; try { token = mintLink(linkKey(name), String(i.slug), expires); } catch { throw refuse("that is not a signer's slug", "bad_input"); }
        return { url: `${await signerOrigin(name)}${SIGNED}${token}`, expires };
      },
    });
    ctx.tool("appmods.signed.revoke", {
      internal: true, callers: ["module"],
      description: "End every link made so far to an app's signed copies: { name } -> { revoked }. The key they were made under is thrown away; links made afterwards use a new one. Only the app's own module asks (documents for Documents).",
      input: obj({ name: str }, ["name"]),
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
        const name = String(i.name || "");
        if (!meta || meta.caller !== `module:${name}`) throw refuse("only the app's own module ends the links to its signed copies", "denied");
        const gone = db.prepare("DELETE FROM appmods_link_keys WHERE name = ?").run(name).changes;
        return { revoked: gone > 0 };
      },
    });
    // ---- servers Publish made (team/contracts/builder.md, the container path). Publish alone calls these, inside the person's held yes.
    const publishOnly = (/** @type {any} */ meta) => { if (!meta || meta.caller !== "module:publish") throw refuse("only Publish runs a site's server", "denied"); };
    const byDeployment = (/** @type {string} */ id) => /** @type {any} */ (db.prepare("SELECT * FROM appmods_published WHERE deployment = ?").get(String(id)));
    ctx.tool("appmods.publish.install", {
      internal: true, callers: ["module"],
      description: "Run (or replace) the server of a published site: { deployment } -> { name, state, url }. Publish only, inside the held yes.",
      input: obj({ deployment: { type: "object" } }, ["deployment"]),
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
        publishOnly(meta);
        const d = i.deployment || {};
        const sp = String(d.space || "");
        if (!/^spc_[a-z2-7]{12}$/.test(sp)) throw refuse("the deployment names no Space", "bad_input");
        const catalogNames = [...catalog.values()].filter(x => !x["x-publish"]).map(x => x.name);
        let m; try { m = publishedManifest(d, { catalogNames, public: true }); } catch (e) { throw refuse(String(/** @type {Error} */ (e).message), "bad_input"); }
        const problems = checkPublished(m);
        if (problems.length) throw refuse(`that server cannot run here: ${problems.map(p => `${p.path}: ${p.message}`).join("; ")}`, "bad_input");
        const have = row(m.name), mine = db.prepare("SELECT * FROM appmods_published WHERE name = ?").get(m.name);
        if (have && !mine) throw refuse(`${m.name} is an app installed on this server already (appmods.status shows how it is doing)`, "exists");
        // the secrets are read before anything stops: a missing one leaves the running version as it was
        db.prepare("INSERT OR REPLACE INTO appmods_published (name, deployment, space, manifest) VALUES (?,?,?,?)").run(m.name, d.id, sp, JSON.stringify(m));
        const keep = catalog.get(m.name); catalog.set(m.name, m);
        let secrets; try { secrets = publishedSecrets(m); } catch (e) { if (keep) catalog.set(m.name, keep); else { catalog.delete(m.name); db.prepare("DELETE FROM appmods_published WHERE name = ?").run(m.name); } throw e; }
        const at = space();
        if (have) { await driver.down({ space: have.space, manifest: keep || m }, { data: false }); tickets.drop(m.name); }
        if (have) db.prepare("UPDATE appmods_apps SET version = ?, state = 'installing', origin = NULL, note = NULL WHERE name = ?").run(m.version, m.name);
        else db.prepare("INSERT INTO appmods_apps (name, space, version, state, origin, hook_port, login_email, installed, note) VALUES (?,?,?,?,?,?,?,?,?)").run(m.name, at, m.version, "installing", null, 0, "", Date.now(), null);
        try {
          const up = await driver.up({ space: at, manifest: m, vars: { name: m.name, origin: originFor(m.name, baseHost()) }, secrets, publishSpace: sp });
          db.prepare("UPDATE appmods_apps SET origin = ? WHERE name = ?").run(up.origin, m.name);
          await healthy(m, up.origin);
          db.prepare("UPDATE appmods_apps SET state = 'running' WHERE name = ?").run(m.name);
        } catch (e) {
          db.prepare("UPDATE appmods_apps SET state = 'failed', note = ? WHERE name = ?").run(String(/** @type {Error} */ (e).message).slice(0, 300), m.name);
          throw e;
        }
        ctx.events.emit("appmods.installed", { name: m.name, version: m.version, source: "publish", deployment: d.id });
        return { name: m.name, state: "running", url: originFor(m.name, baseHost()) };
      },
    });
    ctx.tool("appmods.publish.stop", {
      internal: true, callers: ["module"],
      description: "Stop a published site's server: { deployment } -> { name, state }. Publish only.",
      input: obj({ deployment: str }, ["deployment"]),
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
        publishOnly(meta);
        const p = byDeployment(i.deployment); if (!p) return { name: null, state: "none" };
        const r = row(p.name);
        if (r) { await driver.stop({ space: r.space, manifest: known(p.name) }); db.prepare("UPDATE appmods_apps SET state = 'stopped' WHERE name = ?").run(p.name); tickets.drop(p.name); ctx.events.emit("appmods.stopped", { name: p.name, source: "publish", deployment: p.deployment }); }
        return { name: p.name, state: "stopped" };
      },
    });
    ctx.tool("appmods.publish.remove", {
      internal: true, callers: ["module"],
      description: "Remove a published site's server: { deployment, data? } -> { name, removed }. Its data stays unless data is true. Publish only.",
      input: obj({ deployment: str, data: { type: "boolean" } }, ["deployment"]),
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
        publishOnly(meta);
        const p = byDeployment(i.deployment); if (!p) return { name: null, removed: false };
        const r = row(p.name);
        if (r) await driver.down({ space: r.space, manifest: known(p.name) }, { data: i.data === true });
        db.prepare("DELETE FROM appmods_apps WHERE name = ?").run(p.name);
        db.prepare("DELETE FROM appmods_published WHERE name = ?").run(p.name);
        catalog.delete(p.name); tickets.drop(p.name);
        ctx.events.emit("appmods.removed", { name: p.name, source: "publish", deployment: p.deployment });
        return { name: p.name, removed: true };
      },
    });
    ctx.tool("appmods.signing.request", {
      internal: true, callers: ["module"],
      description: "Ask a running signing app for one signature, with no email from the app: { name, template_id, email, signer? } -> { submission, slug, url }. Only the app's own module asks (documents for Documents). Nothing leaves this server; the link is the signer's page.",
      input: obj({ name: str, template_id: { type: "integer" }, email: str, signer: str }, ["name", "template_id", "email"]),
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
        const name = String(i.name || "");
        if (!meta || meta.caller !== `module:${name}`) throw refuse("only the app's own module asks for a signature", "denied");
        const r = row(name); if (!r || r.state !== "running" || !r.origin) throw refuse("that app is not running (appmods.status shows its state, appmods.start starts it)", "not_found");
        if (!(known(name).app || {}).signing) throw refuse("that app does not collect signatures: install one that does (appmods.catalog lists the apps)", "unsupported");
        let body; try { body = requestBody(Number(i.template_id), String(i.email || ""), i.signer); } catch (e) { throw refuse(/** @type {Error} */ (e).message, "bad_input"); }
        const res = await fetch(`${r.origin}/api/submissions`, { method: "POST", headers: { "content-type": "application/json", "x-auth-token": await secret(name, "api-token") }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw refuse(`${name} would not make the signing request (${res.status}); check that template ${body.template_id} exists`, "app_refused");
        const got = readRequest(await res.json().catch(() => null));
        if (!got) throw refuse(`${name} answered, but not with a signing request`, "app_refused");
        return { ...got, url: `${await signerOrigin(name)}/sign/${got.submission}/${got.slug}` };
      },
    });
    ctx.tool("appmods.signing.waiting", {
      internal: true, callers: ["module"],
      description: "The signature requests an app is still waiting on: { name } -> { requests: [{ submission, slug, url, email, signer, template, at }] }, newest first. Only the app's own module asks (documents for Documents). An app that is not running has none.",
      input: obj({ name: str }, ["name"]),
      run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
        const name = String(i.name || "");
        if (!meta || meta.caller !== `module:${name}`) throw refuse("only the app's own module asks what is waiting for a signature", "denied");
        const r = row(name); if (!r || r.state !== "running" || !r.origin || !(known(name).app || {}).signing) return { requests: [] };
        const res = await fetch(`${r.origin}/api/submissions?status=pending&limit=100`, { headers: { "x-auth-token": await secret(name, "api-token") }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
        if (!res || !res.ok) throw refuse(`${name} would not say what is waiting (${res ? res.status : "no answer"})`, "app_refused");
        const origin = await signerOrigin(name);
        return { requests: readWaiting(await res.json().catch(() => null)).map(q => ({ ...q, url: `${origin}/sign/${q.submission}/${q.slug}` })) };
      },
    });
    ctx.tool("appmods.hosts", { description: "The host names the installed apps need served (one per app): the front door's certificate and name must cover them.", input: obj({}), run: async () => ({
      hosts: [...db.prepare("SELECT name FROM appmods_apps WHERE state = 'running'").all().filter((/** @type {any} */ r) => !(catalog.get(r.name) || { app: {} }).app.service).map((/** @type {any} */ r) => new URL(originFor(r.name, baseHost())).host),
        ...domains.list().filter(d => (row(d.app) || {}).state === "running").map(d => d.host)] }) });
    registerDomainTools({ ctx, domains, running: app => (row(app) || {}).state === "running", ownerOrAdmin,
      signingApp: () => { for (const m of catalog.values()) if (m.app && m.app.signing && (row(m.name) || {}).state === "running") return m.name; return null; } });
    /** The address a signer opens: the person's own domain for this app when the public gate serves it, else the app's address under the Space's name. @param {string} name */
    const signerOrigin = async name => {
      if (ctx.config && ctx.config.relay && ctx.config.relay.tunnel_url && domains.list().some(d => d.app === name)) {
        const r = /** @type {any} */ (await ctx.call("wink.public.hosts", {}).catch(() => null));
        const live = ((r && r.data && r.data.hosts) || []).filter((/** @type {any} */ h) => h.state === "live").map((/** @type {any} */ h) => String(h.host));
        const own = ownOrigin(domains.list(), name, live);
        if (own) return own;
      }
      return originFor(name, baseHost());
    };

    // Apps that were running when this daemon stopped come back with it.
    for (const r of db.prepare("SELECT * FROM appmods_apps WHERE state = 'running'").all()) {
      (byHelper && !known(r.name)["x-publish"] ? Promise.resolve({}) : secretsOf(known(r.name))).then((/** @type {any} */ secrets) => driver.up({ space: r.space, manifest: known(r.name), vars: { name: r.name, origin: originFor(r.name, baseHost()) }, secrets, hookPort: r.hook_port, ...pubSpaceOf(known(r.name)) }))
        .then((/** @type {any} */ up) => { db.prepare("UPDATE appmods_apps SET origin = ? WHERE name = ?").run(up.origin, r.name); if (!known(r.name)["x-publish"]) listen(known(r.name), up.hookHost, r.hook_port); })
        .catch((/** @type {Error} */ e) => ctx.log.warn(`appmods: ${r.name} did not come back: ${e.message}`));
    }
    return { async stop() { offRotate(); for (const t of rotating.values()) clearTimeout(t); rotating.clear(); for (const s of listeners.values()) s.close(); listeners.clear(); front.close(); } };
  },
};
