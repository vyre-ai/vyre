// @ts-check
// publish: put a site or app on the internet from a space (SPEC-core-contract section 13). The rules live in lib/publish
// (createPublisher); this module wires them to the box: SQLite for the records, the spaces module for who is who, the
// vault for secrets, a builder module for builds, the seal ledger for the sealed-value check, and an Ask for every held act.
//
// Held acts (approve, publish, rollback, giving a real secret) take two calls. The first answers { held: true, task, plan }
// and files an Ask. A PERSON then decides it with publish.decide, which completes the act as that person. A model chain
// can create, preview and request; it can never decide. Nothing here starts Docker: publish.edge writes the compose
// project and the Caddyfile into <home>/publish/<spaceId>/ and stops.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import dns from "node:dns/promises";
import { fail } from "../../lib/publish/util.js";
import { folderRefusal } from "../../lib/publish/folder-build.js";
import { isPerson } from "../../lib/caller.js";
import { withSecretGrants, moveSecretsToGrants } from "../../lib/publish/grants.js";
import { createPublisher, PublishError } from "../../lib/publish/index.js";
import { composeText, assertIsolated, caddyDockerfile, IMAGES } from "../../lib/publish/edge.js";
import { edgePlan, runPlan, stopEdge } from "../../lib/publish/runner.js";
import { execFile } from "node:child_process";
import { joinPageHtml } from "../../lib/publish/join.js";
import { writeSiteFiles, volumeFill, siteFolder, sweepSites } from "../../lib/publish/site-write.js";
import { checkBuildForSealed } from "../../lib/publish/secrets.js";
import { createRoleAuthorize } from "../../lib/spaces/authz.js";
import { NO_BUILDER } from "./builder-plan.js";
import { newPrefixedId } from "../../lib/id.js";

export { buildctlArgs } from "./builder-plan.js";

/**
 * Seams for tests: the DNS resolver and `docker`. Everything else a test fills is a fake module behind a tool.
 * `docker` runs the host's docker CLI as an argument vector (no shell) only when the supervisor says this box may start the edge (VYRE_PUBLISH_DOCKER=1);
 * otherwise it is null and publish.edge.up answers not_available with the plan.
 */
export const seams = {
  dns: { resolveTxt: (/** @type {string} */ name) => dns.resolveTxt(name) },
  /** How long a burst of key changes waits before a live server restarts (tests shorten it). @type {number | undefined} */
  restartMs: undefined,
  /** @type {null | ((argv: string[]) => Promise<{ code: number }>)} */
  docker: process.env.VYRE_PUBLISH_DOCKER === "1"
    ? argv => new Promise(resolve => execFile("docker", argv, { timeout: 15 * 60_000, maxBuffer: 1 << 20 }, err => resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0 })))
    : null,
};

export const MIGRATIONS = [
  `
  CREATE TABLE publish_deployments (space TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (space, id));
  CREATE TABLE publish_domains (space TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (space, id));
  CREATE TABLE publish_holds (space TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (space, id));
  CREATE TABLE publish_tasks (space TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (space, id));
  `,
];

/** The site folders the live deployments (Preview, Approved, Production) name; the rest are swept. @param {any[]} records */
const liveSiteNames = records => new Set(records.filter(d => ["Preview", "Approved", "Production"].includes(d.stage) && d.site && typeof d.site.name === "string").map(d => d.site.name));

const TABLES = /** @type {Record<string, string>} */ ({ deployments: "publish_deployments", domains: "publish_domains", holds: "publish_holds", tasks: "publish_tasks" });
const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });
const NO_TOOL = new Set(["no_such_tool", "not_available"]);
const str = { type: "string" };
const obj = (/** @type {any} */ properties, /** @type {string[]} */ required = []) => ({ type: "object", properties: { space: str, ...properties }, required });
const MAX_CANDIDATES = 400_000;
/** The person's own surfaces and Vyre's modules. A tool that builds, names a domain, hands out a secret or writes the edge is theirs: a model asks through the held acts below, or the person does it. */
/** What publish.quick says while the box has no public door. */
const PUBLIC_LATER = "Public once the public door is on. Until then the address works on your own devices only.";
const PEOPLE = ["cli", "local", "deck", "capsule", "tailnet", "device", "module"];
/** The draft and the three held acts (approve, publish, rollback): a model may start a draft and ask, and the publisher holds every act for a person's decision (publish.decide), so a model alone puts nothing live. */
const WITH_MODELS = [...PEOPLE, "mcp", "harness"];

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    ctx.store.migrate(MIGRATIONS);
    const db = ctx.store.db;
    const home = ctx.paths.root;
    const publishDir = (/** @type {string} */ spaceId) => path.join(home, "publish", spaceId);

    /** Call another module's tool. A missing tool is { missing: true }, any other refusal throws. @param {string} tool @param {any} input */
    async function call(tool, input, opts) {
      const r = await ctx.call(tool, input, opts);
      if (r && r.error) {
        if (NO_TOOL.has(r.error.code)) return { missing: true, data: null };
        throw refuse(r.error.message, r.error.code);
      }
      return { missing: false, data: r ? r.data : null };
    }

    // ---- the store, scoped to one space ----
    /** @param {string} space */
    const rawStoreFor = space => ({
      async get(/** @type {string} */ coll, /** @type {string} */ id) {
        const row = /** @type {any} */ (db.prepare(`SELECT body FROM ${TABLES[coll]} WHERE space = ? AND id = ?`).get(space, id));
        return row ? JSON.parse(row.body) : null;
      },
      async put(/** @type {string} */ coll, /** @type {string} */ id, /** @type {any} */ value) {
        db.prepare(`INSERT INTO ${TABLES[coll]} (space, id, body) VALUES (?,?,?) ON CONFLICT(space, id) DO UPDATE SET body = excluded.body`).run(space, id, JSON.stringify(value));
      },
      async delete(/** @type {string} */ coll, /** @type {string} */ id) { db.prepare(`DELETE FROM ${TABLES[coll]} WHERE space = ? AND id = ?`).run(space, id); },
      async list(/** @type {string} */ coll) {
        return /** @type {any[]} */ (db.prepare(`SELECT body FROM ${TABLES[coll]} WHERE space = ? ORDER BY rowid`).all(space)).map(r => JSON.parse(r.body));
      },
    });

    /** The Space's kernel grants this module made (a deployment's secrets are kernel grants, lib/publish/grants.js). No kernel, no secrets: nothing is kept anywhere else. */
    const grantsFor = () => {
      const mint = () => { const m = ctx.kernel && ctx.kernel.mint; if (!m) throw refuse("deployment secrets are kernel grants, and this server has no kernel: ask the owner of this server to run a build that has one", "unavailable"); return m; };
      return { list: async (/** @type {string} */ source) => (ctx.kernel && ctx.kernel.mint ? ctx.kernel.mint.list({ source }) : []), make: (/** @type {any} */ i) => mint().make(i), end: (/** @type {any} */ q) => mint().end(q) };
    };
    /** @param {string} space */
    const storeFor = space => withSecretGrants(rawStoreFor(space), grantsFor(), space, () => (ctx.kernel && typeof ctx.kernel.space === "string" ? ctx.kernel.space : undefined));

    // Records from before secrets were grants move now, once. If a move fails the record stays readable as it is (reads add the old list) and the next start tries again; Publish still starts.
    for (const { space } of /** @type {{ space: string }[]} */ (db.prepare("SELECT DISTINCT space FROM publish_deployments").all())) {
      try { await moveSecretsToGrants(rawStoreFor(space), storeFor(space)); } catch { /* retried at the next start */ }
    }

    // ---- who is who: memberships come from the spaces module ----
    /** @type {Map<string, any>} */ const members = new Map();
    /** @param {string} space @param {string} person */
    async function member(space, person) {
      const r = await call("spaces.membership", { space, person });
      if (r.missing) throw refuse("the spaces module is not running, so nobody can be checked: ask the owner of this server to start it", "no_spaces");
      members.set(`${space}:${person}`, r.data || null);
      return r.data || null;
    }
    const authorize = createRoleAuthorize({ membership: member });

    /** The hops after the person in a call's own chain (an assistant's session adds its agent hop), set by whoIs for the call's meta object. @type {WeakMap<object, {kind: string, id: string}[]>} */
    const extras = new WeakMap();
    /** The space and person a call is for. The person comes from the call's own kernel chain (ctx.kernel.chain(meta)) and nothing else: never a caller label. No chain, a service chain or a viewer chain is nobody. @param {any} input @param {any} meta */
    async function whoIs(input, meta) {
      let chain = null;
      try { chain = ctx.kernel && typeof ctx.kernel.chain === "function" ? await ctx.kernel.chain(meta || {}) : null; } catch { chain = null; }
      const first = chain && Array.isArray(chain.hops) && chain.hops[0] ? chain.hops[0] : null;
      if (!first || !first.actor || first.actor.kind !== "person" || chain.viewer === true) throw refuse("only a person, or their own assistant, can do that", "forbidden");
      // The spaces this person is in, from the spaces module's own member lists (spaces.merge-list), not from "who is this device": a server that hosts a team's space holds no identity of its own (the owner's
      // key lives in their app), and the person who is calling is the chain's person all the same.
      const person = String(first.actor.id);
      const r = await call("spaces.merge-list", { person });
      if (r.missing) throw refuse("no space is set up on this machine yet: create one first with spaces.create", "no_space");
      const list = /** @type {{ space: string, name: string }[]} */ ((r.data && Array.isArray(r.data.spaces)) ? r.data.spaces : []);
      if (!list.length) throw refuse("you are not a member of a space on this server", "forbidden");
      const want = input && input.space ? String(input.space) : null;
      const row = want ? list.find(s => s.space === want || s.name === want) : list.length === 1 ? list[0] : null;
      if (!row) throw refuse(want ? "you are not a member of that space" : "you are in more than one space here: say which with `space`", want ? "forbidden" : "no_space");
      if (meta && typeof meta === "object") extras.set(meta, chain.hops.slice(1).map((/** @type {any} */ h) => ({ kind: String(h.actor.kind), id: String(h.actor.id) })));
      return { space: { id: row.space, name: row.name }, person };
    }

    /** The chain for a call: the person, then the hops the call's own chain carries after them (an assistant, an automation). @param {string} spaceId @param {string} person @param {any} meta */
    function chainOf(spaceId, person, meta) {
      const hops = [{ actor: { kind: "person", id: person, space: spaceId }, entered_by: "surface" }];
      for (const h of (meta && typeof meta === "object" && extras.get(meta)) || []) hops.push({ actor: { kind: h.kind, id: h.id, space: spaceId }, entered_by: "registry" });
      return { space: spaceId, hops, labels: { trust: "member", red: "internal", source_spaces: [spaceId] }, built_at: Date.now() };
    }

    // ---- Ask: module-local, and a task in the tasks module too when one exists ----
    /** @param {string} space */
    function askFor(space) {
      const st = storeFor(space);
      return {
        async request(/** @type {any} */ chain, /** @type {any} */ t) {
          let id = newPrefixedId("hold");
          try {
            const r = await call("tasks.create", { title: t.title, source: "module:publish", kind: t.kind, priority: "medium", tags: ["publish"], payload_hash: t.payload_hash });
            const made = r.data && (r.data.id || (r.data.task && r.data.task.id));
            if (!r.missing && typeof made === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(made)) id = made;
          } catch { /* a refusal from tasks leaves the module-local hold, which is complete on its own */ }
          await st.put("tasks", id, { id, state: "needs_check", requested_by: chain.hops.map((/** @type {any} */ h) => `${h.actor.kind}:${h.actor.id}`), ...t });
          return { id };
        },
        async get(/** @type {string} */ id) {
          const t = await st.get("tasks", id);
          return t ? { id, state: t.state, outcome: t.outcome, decided_by: t.decided_by, payload: { payload_hash: t.payload_hash } } : null;
        },
      };
    }

    // ---- secrets: files under the publish folder, values from the vault ----
    /** @param {string} spaceId */
    function secretsFor(spaceId) {
      const dir = path.join(publishDir(spaceId), "secrets");
      return {
        dir,
        classOf: (/** @type {string} */ ref) => (ref.startsWith("vault://config/") ? "config" : "secret"),
        async read(/** @type {string} */ ref, /** @type {{ deployment?: string }} */ o = {}) {
          try { return await ctx.vault.fetch(ref.replace(/^vault:\/\//, ""), { deployment: o.deployment }); }
          catch (/** @type {any} */ e) {
            if (/not running|not_available|no_such_tool/.test(String(e && (e.code || e.message)))) throw refuse("no vault secret store available: ask the owner of this server to start the vault", "no_vault");
            throw e;
          }
        },
        async writeFile(/** @type {string} */ file, /** @type {string} */ value, /** @type {{ mode: number }} */ o) {
          fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
          try { fs.unlinkSync(file); } catch { /* none yet */ }
          fs.writeFileSync(file, value, { mode: o.mode });
          fs.chmodSync(file, o.mode);
        },
        async removeFile(/** @type {string} */ file) {
          try { fs.unlinkSync(file); } catch { /* already gone */ }
          try { fs.rmdirSync(path.dirname(file)); } catch { /* not empty or gone */ }
        },
      };
    }

    // ---- the sealed-value ledger, through seal.ledger.has when a seal module exists ----
    /** Per space: the lengths the ledger tracks and the answers for this build's windows. */
    function ledgerFor() {
      /** @type {{ lens: number[], hits: Map<string, any>, overflow: boolean, state: "connected" | "none" }} */
      const s = { lens: [], hits: new Map(), overflow: false, state: "none" };
      return {
        s,
        ledger: { lengths: () => s.lens, has: (/** @type {string} */ c) => (s.overflow ? "unverified" : s.hits.get(c) || false) },
        /** Look up every window of this build's output with the ledger, in batches, before the lib checks it. @param {any} out */
        async prime(out) {
          s.lens = []; s.hits = new Map(); s.overflow = false;
          const r = await call("seal.ledger.has", { lengths: true });
          if (r.missing || !r.data || !Array.isArray(r.data.lengths)) { s.state = "none"; return; }
          s.state = "connected";
          s.lens = r.data.lengths.filter((/** @type {any} */ n) => Number.isInteger(n));
          if (!s.lens.length) return;
          /** @type {Set<string>} */ const seen = new Set();
          const recorder = { lengths: () => s.lens, has: (/** @type {string} */ c) => { if (seen.size < MAX_CANDIDATES) seen.add(c); else s.overflow = true; return false; } };
          checkBuildForSealed({ files: out.files || [], logs: out.logs || "" }, recorder);
          const all = [...seen];
          for (let i = 0; i < all.length; i += 5000) {
            const h = await call("seal.ledger.has", { candidates: all.slice(i, i + 5000) });
            const hits = h.data && h.data.hits && typeof h.data.hits === "object" ? h.data.hits : {};
            for (const [c, v] of Object.entries(hits)) if (v) s.hits.set(c, v);
          }
        },
      };
    }

    // ---- a built server runs as an app module (team/contracts/builder.md): Publish writes its granted runtime secrets as files, appmods runs the container ----
    /** @param {{ id: string, name: string }} space */
    function runnerFor(space) {
      const names = (/** @type {any} */ d) => (d.secrets || []).filter((/** @type {any} */ s) => s.use.includes("runtime")).map((/** @type {any} */ s) => s.name);
      return {
        async start(/** @type {any} */ d) {
          const files = secretsFor(space.id);
          // each value is released by the Vault to Publish only on this deployment's live grant, and written where only the apps module reads it, mode 0600
          for (const s of (d.secrets || [])) if (s.use.includes("runtime")) await files.writeFile(path.join(files.dir, d.id, s.name), await files.read(s.ref, { deployment: d.id }), { mode: 0o600 });
          const r = await call("appmods.publish.install", { deployment: { id: d.id, space: space.id, name: d.name, version: d.version, runtime: d.runtime, secrets: names(d) } });
          if (r.missing) throw refuse("this server has no apps module to run a site's server", "no_runner");
          return r.data;
        },
        async remove(/** @type {any} */ d) {
          await call("appmods.publish.remove", { deployment: d.id });
          const files = secretsFor(space.id);
          for (const s of (d.secrets || [])) await files.removeFile(path.join(files.dir, d.id, s.name));
        },
      };
    }

    // ---- one publisher per space, built on first use ----
    /** @type {Map<string, { pub: any, ledger: ReturnType<typeof ledgerFor>, lock: Promise<any> }>} */
    const publishers = new Map();
    /** @param {{ id: string, name: string }} space */
    function publisherFor(space) {
      let p = publishers.get(space.id);
      if (p) return p;
      const led = ledgerFor();
      const builder = {
        async build(/** @type {any} */ deployment, /** @type {{ secretArgs: string[] }} */ io) {
          const r = await call("builder.build", { deployment, secretArgs: io.secretArgs });
          if (r.missing) throw refuse(NO_BUILDER, "no_builder");
          await led.prime(r.data);
          return r.data;
        },
      };
      const pub = createPublisher({
        space,
        clock: { now: () => Date.now() },
        random: n => crypto.randomBytes(n),
        authorize,
        events: {
          emit: async e => {
            // The event carries the deployment and the plain facts the lib named; never the chain, never a value.
            ctx.events.emit(String(e.type).replace(/_/g, "-"), { deployment: e.subject, space: space.id, ...(e.data && typeof e.data === "object" ? e.data : {}) });
          },
        },
        store: storeFor(space.id),
        dns: { resolveTxt: name => seams.dns.resolveTxt(name) },
        ledger: led.ledger,
        secrets: secretsFor(space.id),
        ask: askFor(space.id),
        roles: {
          roleOf: id => { const m = members.get(`${space.id}:${id}`); return m ? m.role : null; },
          managesProject: (id, project) => { const m = members.get(`${space.id}:${id}`); return !!m && Array.isArray(m.projects) && m.projects.includes(project); },
        },
        names: { owns: async (host, spaceId) => { const r = await call("names.owns", { host, space: spaceId }); return !r.missing && !!(r.data && (r.data === true || r.data.owns === true)); } },
        builder,
        runner: runnerFor(space),
        // The checked files of a static build go into a fresh folder under the space's publish folder (private, 0700); `publish.edge` hands the box the copy into the site volume.
        site: { write: async (/** @type {string} */ _id, /** @type {any[]} */ files) => {
          const sites = path.join(publishDir(space.id), "sites");
          fs.mkdirSync(sites, { recursive: true, mode: 0o700 });
          // Folders no live deployment names (retired, rolled back, superseded, left by a refused build) go before a new one is made, and the total is capped.
          sweepSites(sites, liveSiteNames(await storeFor(space.id).list("deployments")));
          return { dir: writeSiteFiles(sites, files) };
        } },
      });
      p = { pub, ledger: led, lock: Promise.resolve() };
      publishers.set(space.id, p);
      return p;
    }

    /** Everything a tool needs: who is calling, the space, the chain and the publisher, with the right roles looked up. @param {any} input @param {any} meta @param {string[]} [extraPeople] */
    async function begin(input, meta, extraPeople = []) {
      const { space, person } = await whoIs(input, meta);
      const chain = chainOf(space.id, person, meta);
      for (const id of new Set([person, ...extraPeople])) await member(space.id, id);
      return { space, person, chain, ...publisherFor(space) };
    }
    /** Warm the role of whoever decided a task, before the lib reads it. @param {string} spaceId @param {string|undefined} task */
    async function warmDecider(spaceId, task) {
      if (!task) return [];
      const t = await storeFor(spaceId).get("tasks", String(task));
      const id = t && t.decided_by && t.decided_by.hops && t.decided_by.hops[0] && t.decided_by.hops[0].actor.id;
      return id ? [String(id)] : [];
    }
    /** Run builds of one space one at a time, since the ledger state is per build. @param {{ lock: Promise<any> }} p @param {() => Promise<any>} fn */
    function serial(p, fn) {
      const next = p.lock.then(fn, fn);
      p.lock = next.catch(() => {});
      return next;
    }

    /** What may leave the module about a deployment: no secret values exist on it, but the shape is fixed anyway. @param {any} d */
    const shown = d => d && ({
      id: d.id, name: d.name, version: d.version, stage: d.stage, url: d.url ?? null, previous: d.previous ?? null,
      project: d.project ?? null, build_digest: d.build_digest ?? null, approved_by: d.approved_by ?? null, approved_at: d.approved_at ?? null,
      published_at: d.published_at ?? null, created_by: d.created_by, created_at: d.created_at, updated_at: d.updated_at,
      secrets: (d.secrets || []).map((/** @type {any} */ s) => ({ name: s.name, class: s.class, use: s.use })),
    });

    // ---- tools ----
    ctx.tool("publish.create", {
      callers: WITH_MODELS,
      description: "Start a new site or app as a draft from a name, a source and how it builds.",
      input: obj({ name: str, source: { type: "object" }, build: { type: "object" }, env: { type: "object", description: "secret references, never values" }, project: str, approver: str }, ["name", "source"]),
      run: async (i, meta) => {
        const b = await begin(i, meta);
        const { space: _s, ...draft } = i;
        // A folder on this server is read off its disk by the builder: whose folder it may be is judged here, once, with the caller known.
        if (draft.source && draft.source.kind === "folder") { const no = folderRefusal(String(draft.source.ref || ""), { person: isPerson(meta) }); if (no) throw refuse(no.message, no.code); }
        return { deployment: shown(await b.pub.create(b.chain, draft)) };
      },
    });

    ctx.tool("publish.preview", {
      callers: WITH_MODELS,
      description: "Build a draft and put it at a private preview address. Refused if the build output holds a sealed value or secret.",
      input: obj({ deployment: str }, ["deployment"]),
      run: async (i, meta) => {
        const b = await begin(i, meta);
        const r = await serial(b, () => b.pub.preview(b.chain, i.deployment));
        return { deployment: shown(r.deployment), logs: r.logs };
      },
    });

    ctx.tool("publish.plan", {
      description: "What would change if the next step ran: what goes public, at which address, with which secrets, replacing which version.",
      input: obj({ deployment: str }, ["deployment"]),
      run: async (i, meta) => { const b = await begin(i, meta); return { plan: await b.pub.plan(b.chain, i.deployment) }; },
    });

    /** The three held acts share one shape. @param {"approve" | "publish" | "rollback"} act */
    const heldTool = act => async (/** @type {any} */ i, /** @type {any} */ meta) => {
      const b = await begin(i, meta, await warmDecider(String((await whoIs(i, meta)).space.id), i.task));
      const r = await b.pub[act](b.chain, i.deployment, i.task ? { task: i.task } : {});
      if (r.held) return { held: true, task: r.task, plan: r.plan };
      return { deployment: shown(r.deployment), ...(r.retired !== undefined ? { retired: shown(r.retired) } : {}) };
    };
    ctx.tool("publish.approve", {
      callers: WITH_MODELS,
      description: "Approve a preview. The first call asks and holds; a person's decision (publish.decide) completes it, or call again with the task once it is decided.",
      input: obj({ deployment: str, task: str }, ["deployment"]),
      run: heldTool("approve"),
    });
    ctx.tool("publish.publish", {
      callers: WITH_MODELS,
      description: "Put an approved version on the internet. Held for a person every time: the first call asks, a person decides with publish.decide.",
      input: obj({ deployment: str, task: str }, ["deployment"]),
      run: heldTool("publish"),
    });
    ctx.tool("publish.go", {
      callers: WITH_MODELS,
      description: "Approve a previewed version and put it live with one yes. The first call holds; a person's decision (publish.decide) completes it.",
      input: obj({ deployment: str, task: str }, ["deployment"]),
      run: heldTool("goLive"),
    });
    ctx.tool("publish.quick", {
      callers: WITH_MODELS,
      description: "Publish a folder of ready files, or a files preview by id: build, preview, hold for one yes. Answers the task and plan.",
      input: obj({ name: str, folder: str, preview: str, project: str }, ["name"]),
      run: async (i, meta) => {
        const b = await begin(i, meta);
        // a preview card publishes its own folder: the person who pressed it, the home resolves the folder, a surface never sends a path
        if (!!i.folder === !!i.preview) throw refuse("name the folder to publish, or the preview to publish, not both and not neither", "bad_input");
        if (i.preview) {
          if (!isPerson(meta)) throw refuse("publishing a preview is the person's: ask them to press Publish on its card", "denied");
          const f = await call("previews.folder", { id: String(i.preview) }, { relay: true });
          if (f.missing) throw refuse("this server has no previews to publish from", "no_previews");
          i = { ...i, folder: String(f.data.root) };
        }
        const no = folderRefusal(String(i.folder || ""), { person: isPerson(meta) });
        if (no) throw refuse(no.message, no.code);
        const made = await b.pub.create(b.chain, { name: i.name, source: { kind: "folder", ref: i.folder }, build: { image: "static" }, ...(i.project ? { project: i.project } : {}) });
        const pv = await serial(b, () => b.pub.preview(b.chain, made.id));
        const held = await b.pub.goLive(b.chain, made.id, {});
        // until the public door (names.status listening) is on, the address a yes makes live is reachable on the person's own devices only: say so, in the same answer as the yes
        const door = await call("names.status", {}).catch(() => ({ data: null }));
        const open = Boolean(door.data && door.data.listening === true);
        return { deployment: shown(pv.deployment), logs: pv.logs, held: true, task: held.task, plan: held.plan, public: open, ...(open ? {} : { note: PUBLIC_LATER }) };
      },
    });
    ctx.tool("publish.rollback", {
      callers: WITH_MODELS,
      description: "Put the previous version back. Give the live deployment. Held for a person every time.",
      input: obj({ deployment: str, task: str }, ["deployment"]),
      run: heldTool("rollback"),
    });

    ctx.tool("publish.decide", {
      description: "A person's decision on a held act. Approving completes the act as that person; declining ends it. A model never decides.",
      input: obj({ task: str, approve: { type: "boolean" }, plan_hash: str }, ["task", "approve"]),
      presence: true,
      run: async (i, meta) => {
        const { space, person } = await whoIs(i, meta);
        if ((extras.get(meta) || []).length) throw refuse("a person decides this, not a model", "model_cannot_approve");
        const m = await member(space.id, person);
        if (!m) throw refuse("you are not a member of this space", "forbidden");
        const st = storeFor(space.id);
        const task = await st.get("tasks", String(i.task));
        const hold = await st.get("holds", String(i.task));
        if (!task || !hold) throw refuse("that request does not exist or was already handled: give the id of one still waiting for a decision", "not_found");
        if (task.state !== "needs_check") throw refuse("that request was already decided", "already_decided");
        if (i.plan_hash !== undefined && i.plan_hash !== task.payload_hash) throw refuse("what would change is different from what you saw; ask again", "approval_mismatch");
        const chain = chainOf(space.id, person, { caller: "cli" });
        const outcome = i.approve ? "approved" : "declined";
        if (!i.approve) {
          await st.put("tasks", task.id, { ...task, state: "done", outcome, decided_by: chain, decided_at: Date.now() });
          await st.delete("holds", task.id);
          return { task: task.id, outcome };
        }
        const p = publisherFor(space);
        await st.put("tasks", task.id, { ...task, state: "done", outcome, decided_by: chain, decided_at: Date.now(), ...(meta && meta.presence ? { presence: meta.presence.method } : {}) });
        try {
          const out = { task: task.id, outcome };
          if (hold.action === "grant_secret") {
            const s = (task.plan || {}).secret || {};
            const r = await p.pub.grantSecret(chain, hold.deployment, { ref: s.ref, name: s.name, use: s.use, task: task.id });
            return { ...out, deployment: shown(r.deployment) };
          }
          const r = await serial(p, () => p.pub[hold.action](chain, hold.deployment, { task: task.id }));
          return { ...out, deployment: shown(r.deployment), ...(r.retired !== undefined ? { retired: shown(r.retired) } : {}) };
        } catch (e) {
          // The act did not complete (for example this person may not approve it): the request stays open for someone who may.
          await st.put("tasks", task.id, task);
          throw e;
        }
      },
    });

    ctx.tool("publish.retire", {
      description: "Take a version down and keep its record.",
      input: obj({ deployment: str }, ["deployment"]),
      run: async (i, meta) => { const b = await begin(i, meta); return { deployment: shown((await b.pub.retire(b.chain, i.deployment)).deployment) }; },
    });

    ctx.tool("publish.status", {
      description: "One site's stage, address, secrets by name, domains and approver. Also says whether the sealed-value check has a ledger behind it. Never a secret value.",
      input: obj({ deployment: str }, ["deployment"]),
      run: async (i, meta) => {
        const b = await begin(i, meta);
        const s = await b.pub.status(b.chain, i.deployment);
        const probe = await call("seal.ledger.has", { lengths: true });
        return { ...s, sealed_check: probe.missing ? "no ledger: sealed values are not checked" : "ledger connected" };
      },
    });

    ctx.tool("publish.list", {
      description: "Every site in the space with its stage and address, newest first. Optional stage or name filter.",
      input: obj({ stage: str, name: str }),
      run: async (i, meta) => {
        const b = await begin(i, meta);
        const rows = await storeFor(b.space.id).list("deployments");
        /** @type {any[]} */ const out = [];
        for (const d of rows.sort((x, y) => y.created_at - x.created_at)) {
          if ((i.stage && d.stage !== i.stage) || (i.name && d.name !== i.name)) continue;
          const s = await b.pub.status(b.chain, d.id);
          out.push({ id: s.id, name: s.name, version: s.version, stage: s.stage, url: s.url, domains: s.domains });
        }
        return { deployments: out };
      },
    });

    ctx.tool("publish.domain.add", {
      callers: PEOPLE,
      description: "Start connecting a domain to a site. Returns the DNS record to add; nothing serves until it is verified and the site is published.",
      input: obj({ host: str, deployment: str, canonical: { type: "string", enum: ["apex", "www"] }, www: { type: "boolean" } }, ["host", "deployment"]),
      run: async (i, meta) => {
        const b = await begin(i, meta);
        const r = await b.pub.addDomain(b.chain, { host: i.host, deployment: i.deployment, canonical: i.canonical, www: i.www });
        return { domain: { host: r.record.host, status: r.record.status, method: r.record.method }, challenge: r.challenge };
      },
    });
    ctx.tool("publish.domain.verify", {
      callers: PEOPLE,
      description: "Check the DNS record (or the name you own) for a connected domain.",
      input: obj({ host: str }, ["host"]),
      run: async (i, meta) => {
        const b = await begin(i, meta);
        const r = await b.pub.verifyDomain(b.chain, i.host);
        return { verified: r.verified, ...(r.reason ? { reason: r.reason } : {}), ...(r.challenge ? { challenge: r.challenge } : {}), domain: { host: r.record.host, status: r.record.status } };
      },
    });
    ctx.tool("publish.domain.remove", {
      description: "Disconnect a domain from its site.",
      input: obj({ host: str }, ["host"]),
      run: async (i, meta) => { const b = await begin(i, meta); return b.pub.removeDomain(b.chain, i.host); },
    });

    ctx.tool("publish.secret.grant", {
      callers: WITH_MODELS,
      description: "Let one deployment use one vault secret, as an environment name. A real secret is held for a person; nothing is shared with other deployments.",
      input: obj({ deployment: str, ref: str, name: str, use: { type: "array", items: { type: "string", enum: ["build", "runtime"] } }, task: str }, ["deployment", "ref", "name"]),
      run: async (i, meta) => {
        const sp = (await whoIs(i, meta)).space.id;
        const b = await begin(i, meta, await warmDecider(sp, i.task));
        const r = await b.pub.grantSecret(b.chain, i.deployment, { ref: i.ref, name: i.name, use: i.use, task: i.task });
        if (r.held) return { held: true, task: r.task, plan: r.plan };
        return { deployment: shown(r.deployment) };
      },
    });
    ctx.tool("publish.secret.revoke", {
      callers: PEOPLE,
      description: "Take a secret away from a deployment and delete its file.",
      input: obj({ deployment: str, name: str }, ["deployment", "name"]),
      run: async (i, meta) => {
        const b = await begin(i, meta);
        const r = await b.pub.revokeSecret(b.chain, i.deployment, i.name);
        const files = secretsFor(b.space.id);
        await files.removeFile(path.join(files.dir, i.deployment, i.name));
        // a live server is started again without it: the container's environment is made at start, so taking the file away alone would leave the secret in the running process
        if (r.deployment.stage === "Production" && r.deployment.runtime && r.deployment.runtime.kind === "image") await runnerFor(b.space).start(r.deployment);
        return { deployment: shown(r.deployment) };
      },
    });

    ctx.tool("publish.edge", {
      callers: PEOPLE,
      description: "Write the edge for what is live now: a compose project, a Caddyfile and the Dockerfile of its Caddy image in <home>/publish/<space>/, and the runtime secret files its sites were granted. It does not start anything.",
      input: obj({}),
      run: (i, meta) => writeEdge(i, meta),
    });
    const writeEdge = async (/** @type {any} */ i, /** @type {any} */ meta) => {
        const b = await begin(i, meta);
        const { compose, caddyfile } = await b.pub.edge(b.chain);
        assertIsolated(compose);
        const dir = publishDir(b.space.id);
        fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
        const files = secretsFor(b.space.id);
        /** @type {Array<{ path: string, mode: string }>} */ const written = [];
        const put = async (/** @type {string} */ rel, /** @type {string} */ text, /** @type {number} */ mode) => {
          await files.writeFile(path.join(dir, rel), text, { mode });
          written.push({ path: rel, mode: "0" + mode.toString(8) });
        };
        await put("compose.yaml", composeText(compose), 0o644);
        await put("Caddyfile", caddyfile, 0o644);
        await put("caddy.Dockerfile", caddyDockerfile(), 0o644);
        await put("join.html", joinPageHtml(), 0o644);
        // Runtime secrets: only the deployments in the compose, only what each was granted for runtime.
        for (const d of await storeFor(b.space.id).list("deployments")) {
          if (!compose.services["w-" + d.id.replace(/^dep_/, "")] || (d.runtime && d.runtime.kind === "static")) continue;
          for (const s of d.secrets || []) if (s.use.includes("runtime")) await put(path.join("secrets", d.id, s.name), await files.read(s.ref, { deployment: d.id }), 0o600);
        }
        // What starts the project (it is not this module) builds the edge image first: `docker build -t <image> -f caddy.Dockerfile .` in `dir`.
        // Where each live static site's files wait, and the docker call that copies them into the site's volume (the box runs it; this module starts nothing).
        const fills = [];
        const sitesRoot = path.join(publishDir(b.space.id), "sites");
        const records = await storeFor(b.space.id).list("deployments");
        for (const d of records) {
          const slug = d.id.replace(/^dep_/, "");
          if (!compose.services["w-" + slug] || !(d.runtime && d.runtime.kind === "static") || !d.site) continue;
          // The record names a folder; the path is rebuilt here and the folder checked, so an edited record cannot point the copy anywhere else (reviewer-3, FF-1).
          const folder = siteFolder(sitesRoot, d.site.name);
          if (!folder) continue;
          const volume = `${compose.name}_site-${slug}`;
          fills.push({ deployment: d.id, volume, docker: volumeFill(folder, volume, sitesRoot) });
        }
        sweepSites(sitesRoot, liveSiteNames(records));
        return { dir, files: written, compose, caddyfile, fills, build: { image: IMAGES.caddy, dockerfile: "caddy.Dockerfile" } };
    };

    ctx.tool("publish.edge.up", {
      callers: PEOPLE,
      description: "Start the edge: build its Caddy image, copy each live site into its volume and bring the compose project up. Runs publish.edge first. Without a way to start containers on this box it answers not_available and the plan to run by hand.",
      input: obj({}),
      run: async (i, meta) => {
        const r = await writeEdge(i, meta);
        const plan = edgePlan(r);
        return { project: r.compose.name, ...(await runPlan(plan, seams.docker)) };
      },
    });
    ctx.tool("publish.edge.down", {
      callers: PEOPLE,
      description: "Stop the edge. Sites stop answering; their files and certificates stay.",
      input: obj({}),
      run: async (i, meta) => {
        const b = await begin(i, meta);
        if (!seams.docker) fail("not_available", "this box has no way to stop containers; run `docker compose -p " + `vyre-publish-${b.space.id}` + " stop` by hand");
        return stopEdge(`vyre-publish-${b.space.id}`, seams.docker);
      },
    });

    ctx.tool("publish.flow", {
      description: "The publish pipeline for a deployment as a Flow definition: build, preview, a person approves, production, rollback.",
      input: obj({ deployment: str, kernel: { type: "boolean" } }, ["deployment"]),
      run: async (i, meta) => {
        const b = await begin(i, meta);
        await b.pub.status(b.chain, i.deployment);
        return { flow: await b.pub.flow(i.deployment, { kernel: i.kernel === true }) };
      },
    });

    // A key rotated in the Vault reaches a live server (R031-70): every Production server holding a RUNTIME grant on that credential is started again with the new value, once for a burst of changes. A site
    // that only uses the key to build reads the new value at its next build, and a static site holds none.
    /** @type {Map<string, NodeJS.Timeout>} */ const restarting = new Map();
    const restartUsers = async (/** @type {string} */ item) => {
      for (const { space } of /** @type {{ space: string }[]} */ (db.prepare("SELECT DISTINCT space FROM publish_deployments").all())) {
        for (const d of await storeFor(space).list("deployments")) {
          if (d.stage !== "Production" || !d.runtime || d.runtime.kind !== "image" || !(d.secrets || []).some((/** @type {any} */ x) => x.use.includes("runtime") && x.ref === `vault://${item}`)) continue;
          if (restarting.has(d.id)) continue;
          restarting.set(d.id, setTimeout(() => {
            restarting.delete(d.id);
            runnerFor({ id: space, name: space }).start(d).then(() => ctx.events.emit("deployment.restarted", { deployment: d.id, space, why: "a key changed in the Vault" }), (/** @type {Error} */ err) => ctx.log.warn(`publish: ${d.id} did not restart with its new key: ${err.message}`));
          }, seams.restartMs ?? 300));
        }
      }
    };
    const offRotate = ctx.events.on("vault.item-changed", (/** @type {any} */ e) => { const item = String((e.payload || e).name || ""); if (item) restartUsers(item).catch((/** @type {Error} */ err) => ctx.log.warn(`publish: could not look for sites using ${item}: ${err.message}`)); });

    return { async stop() { offRotate(); for (const t of restarting.values()) clearTimeout(t); restarting.clear(); publishers.clear(); members.clear(); } };
  },
};

export { PublishError };
