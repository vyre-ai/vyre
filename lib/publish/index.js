// @ts-check
// lib/publish/index.js: createPublisher(deps), the Publish module's library surface.
// Every act goes through the injected `authorize` with the caller's chain. Every outward act (publish, rollback) and every
// grant of a real secret is HELD: the publisher asks (an Ask task), a person decides, and the act resumes with that task.
// A model chain may request any of it; it can never decide. Nothing here touches the network, Docker or the clock directly.

import { fail, assertChain, deploymentUrn, secretUrn, sha256hex, canonical, DEPLOYMENT_ID_RE, safeEqual } from "./util.js";
import { ACTIONS, normalizeDraft, transition, rollback as rollbackDeployment } from "./deployment.js";
import { prepareSecrets, grantSecret as grantSecretTo, revokeSecret, redact, checkBuildForSealed, checkBuildForSecrets, ungrantedEnv } from "./secrets.js";
import { checkOutputFiles } from "./outputs.js";
import { addDomain as newDomain, verifyDomain as checkDomain, removeDomain as dropDomain, rebind, forCaddy, challengeOf } from "./domains.js";
import { previewHost, defaultHost, edgeCompose, caddyfile } from "./edge.js";
import { publishFlow, publishFlowKernel } from "./flow.js";

export { PublishError } from "./util.js";

/**
 * @typedef {object} Deps
 * @property {{ id: string, name: string }} space
 * @property {{ now(): number }} clock
 * @property {(n: number) => Uint8Array} random
 * @property {(input: { chain: any, action: string, resource: string, input_class?: string }) => Promise<{ effect: "allow" | "deny" | "ask", reason: string, decision: string, obligations?: any[], grants?: string[], policy_version?: number }>} authorize
 * @property {{ emit(event: { type: string, subject: string, data: any, chain: any, decision?: string }): Promise<void> | void }} events
 * @property {{ get(coll: string, id: string): Promise<any>, put(coll: string, id: string, value: any): Promise<void>, delete(coll: string, id: string): Promise<void>, list(coll: string): Promise<any[]> }} store
 * @property {{ resolveTxt(name: string): Promise<string[][]> }} dns
 * @property {{ lengths(): number[], has(candidate: string): boolean | string }} ledger
 * @property {{ classOf(ref: string): Promise<string> | string, read(ref: string, ctx: { deployment: string, purpose: string }): Promise<string>, writeFile(path: string, value: string, opts: { mode: number }): Promise<void>, removeFile?(path: string): Promise<void>, dir: string }} secrets
 * @property {{ request(chain: any, task: { title: string, kind: string, action: string, resource: string, plan: any, payload_hash: string, approver: string }): Promise<{ id: string }>, get(id: string): Promise<null | { id: string, state: string, outcome?: string, decided_by?: any, payload?: { payload_hash: string } }> }} ask
 * @property {{ roleOf(actorId: string): string | null | undefined, managesProject?(actorId: string, project: string): boolean }} roles
 * @property {{ owns(host: string, space: string): Promise<boolean> | boolean }} [names]
 * @property {{ build(deployment: any, io: { secretArgs: string[] }): Promise<{ digest: string, files: Array<{ path: string, content: string | Uint8Array }>, logs: string, runtime?: { kind: "static" | "node", image?: string, port?: number } }> }} builder
 * @property {{ write(deployment: string, files: Array<{ path: string, content: string | Uint8Array }>): Promise<{ dir: string }> | { dir: string } }} [site] where a static build's checked files are written for the box to copy into the site volume (site-write.js)
 * @property {{ perSpace?: number, pendingPerSpace?: number, tokenTtlMs?: number }} [domainLimits]
 */

const DEP = "deployments", DOM = "domains", HOLD = "holds";

/** @param {Deps} deps */
export function createPublisher(deps) {
  const space = deps.space;
  const now = () => deps.clock.now();
  const actorOf = (/** @type {any} */ chain) => chain.hops[chain.hops.length - 1].actor.id;

  /** @param {any} chain @param {string} action @param {string} resource @param {string} [input_class] */
  async function az(chain, action, resource, input_class) {
    assertChain(chain);
    if (chain.space !== space.id) fail("forbidden", "the chain is not in this space");
    const out = await deps.authorize({ chain, action, resource, ...(input_class ? { input_class } : {}) });
    if (!out || out.effect === "deny") fail("forbidden", `not allowed: ${out ? out.reason : "no_grant"}`, { reason: out && out.reason });
    return { ...out, action, resource };
  }
  const load = async (/** @type {string} */ id) => {
    if (!DEPLOYMENT_ID_RE.test(String(id))) fail("not_found", "no such deployment");
    const d = await deps.store.get(DEP, id);
    if (!d) fail("not_found", "no such deployment");
    return d;
  };
  const all = async () => (await deps.store.list(DEP)) || [];
  const domains = async () => (await deps.store.list(DOM)) || [];
  const emit = async (/** @type {any[]} */ events, /** @type {any} */ chain, /** @type {string} */ decision) => { for (const e of events) await deps.events.emit({ ...e, chain, decision }); };

  /** The verified hosts bound to a site, plus a default host when it has none. @param {any} d @param {any} [replaces] */
  async function hostsFor(d, replaces) {
    const ids = new Set([d.id, ...(replaces ? [replaces.id] : [])]);
    const mine = forCaddy(await domains()).filter(x => ids.has(x.deployment));
    return mine.length ? mine.map(x => x.host) : [defaultHost(d.name, space.name)];
  }

  /**
   * What would change, for the Ask card: what goes public, at which URL, with which secrets, replacing which version.
   * @param {any} chain @param {string} id
   */
  async function plan(chain, id) {
    await az(chain, "deploy.read", deploymentUrn(space.id, id));
    return buildPlan(await load(id));
  }
  /** @param {any} d */
  async function buildPlan(d) {
    /** @type {"approve" | "publish" | "rollback"} */
    let action;
    /** @type {any} */ let replaces = null;
    if (d.stage === "Preview") action = "approve";
    else if (d.stage === "Approved") action = "publish";
    else if (d.stage === "Production") action = "rollback";
    else return fail("illegal_transition", `nothing to plan for a deployment in ${d.stage}`);
    const live = (await all()).find(x => x.stage === "Production" && x.name === d.name && x.id !== d.id) || null;
    let target = d;
    if (action === "rollback") {
      if (!d.previous) fail("no_previous", "there is no previous version to go back to");
      target = await load(d.previous);
      replaces = d;
    } else if (action === "publish") replaces = live;
    const body = {
      action,
      goes_public: action !== "approve",
      deployment: { id: target.id, name: target.name, version: target.version, build_digest: target.build_digest ?? null },
      urls: action === "approve" ? [d.url] : (await hostsFor(target, replaces)).map(h => `https://${h}`),
      replaces: replaces ? { id: replaces.id, version: replaces.version, url: replaces.url ?? null } : null,
      secrets: (target.secrets || []).map((/** @type {any} */ s) => ({ name: s.name, class: s.class, use: s.use })),
      ungranted_env: ungrantedEnv(target),
    };
    return { ...body, hash: sha256hex(canonical(body)) };
  }

  /** Ask for a held act and remember it. @param {any} chain @param {any} d @param {string} action @param {any} p @param {string} resource */
  async function hold(chain, d, action, p, resource) {
    const t = await deps.ask.request(chain, { title: titleOf(p, d), kind: action === "approve" ? "write" : "outward.publish", action, resource, plan: p, payload_hash: p.hash, approver: d.approver || "owner" });
    await deps.store.put(HOLD, t.id, { task: t.id, deployment: d.id, action, hash: p.hash, requested_by: actorOf(chain), created_at: now() });
    return { held: /** @type {true} */ (true), task: t.id, plan: p };
  }
  const titleOf = (/** @type {any} */ p, /** @type {any} */ d) => p.action === "rollback" ? `Go back to version ${p.deployment.version} of ${d.name}` : p.action === "publish" ? `Put version ${d.version} of ${d.name} on the internet` : `Approve the preview of ${d.name}`;

  /** Read the decision on a held act. Returns the approval to hand the state machine, and consumes the hold. @param {string} task @param {string} depId @param {string} action @param {string} hash */
  async function decided(task, depId, action, hash) {
    const h = await deps.store.get(HOLD, String(task));
    if (!h || h.deployment !== depId || h.action !== action) fail("approval_mismatch", "that approval was not requested for this");
    if (!safeEqual(h.hash, hash)) fail("approval_mismatch", "what would change is different from what was asked; ask again");
    const t = await deps.ask.get(task);
    if (!t) fail("needs_approval", "that approval does not exist");
    if (t.state !== "done" || !t.outcome) fail("needs_approval", "a person has not decided yet");
    if (t.outcome !== "approved") fail("needs_approval", `the request was ${t.outcome}`);
    return { approval: { task, outcome: "approved", by: t.decided_by, payload_hash: t.payload && t.payload.payload_hash }, consume: () => deps.store.delete(HOLD, String(task)) };
  }

  return {
    ACTIONS,

    /** A new Draft. @param {any} chain @param {any} input */
    async create(chain, input) {
      const clean = normalizeDraft(input);
      const id = "dep_" + Buffer.from(deps.random(8)).toString("hex");
      const authz = await az(chain, "deploy.create", deploymentUrn(space.id, id));
      if (authz.effect !== "allow") fail("needs_approval", "creating a deployment needs an approval first");
      const version = Math.max(0, ...(await all()).filter(d => d.name === clean.name).map(d => d.version)) + 1;
      const t = now();
      const d = { id, space: space.id, ...clean, version, stage: "Draft", url: null, previous: null, secrets: [], created_by: actorOf(chain), created_at: t, updated_at: t };
      await deps.store.put(DEP, id, d);
      return d;
    },

    /** Build, check and preview. @param {any} chain @param {string} id */
    async preview(chain, id) {
      const d = await load(id);
      const authz = await az(chain, "deploy.preview", deploymentUrn(space.id, id));
      if (d.stage !== "Draft") fail("illegal_transition", `a deployment in ${d.stage} cannot be built again; make a new version`);
      const prepared = await prepareSecrets(d, "build", { dir: deps.secrets.dir, readSecret: deps.secrets.read, writeFile: deps.secrets.writeFile });
      let out;
      try {
        out = await deps.builder.build(d, { secretArgs: prepared.args });
      } finally {
        if (deps.secrets.removeFile) for (const f of prepared.files) await deps.secrets.removeFile(f.path);
      }
      // The build's own secrets are redacted from logs and must not be baked into files; sealed values refuse the build.
      const values = prepared.values;
      const logs = redact(out.logs || "", values);
      const files = out.files || [];
      checkOutputFiles(files);
      const baked = checkBuildForSecrets({ files }, values);
      if (!baked.ok) fail("secret_in_build", "a granted secret appears in the build output; the build is refused", { findings: baked.findings });
      const sealed = checkBuildForSealed({ files, logs: out.logs || "" }, deps.ledger);
      if (sealed.unverifiable) fail("build_unverifiable", "the build is too large to check for sealed values; it is refused", { findings: sealed.findings });
      if (!sealed.ok) fail("sealed_in_build", "a sealed value appears in the build output or logs; the build is refused", { findings: sealed.findings });
      const url = "https://" + previewHost(id, space.name);
      const r = transition(d, "Preview", { chain, now: now(), authz, build: { digest: out.digest, sealed_checked: true }, url });
      const runtime = out.runtime || (d.build.image === "static" ? { kind: "static" } : null);
      // A static site's files are written, once checked, into a fresh folder for the box to copy into its volume; nothing else carries them there.
      const site = runtime && runtime.kind === "static" && deps.site ? await deps.site.write(id, files) : null;
      const next = { ...r.deployment, runtime, ...(site ? { site: { dir: site.dir } } : {}) };
      await deps.store.put(DEP, id, next);
      await emit(r.events, chain, authz.decision);
      return { deployment: next, logs };
    },

    plan,

    /** Preview -> Approved. Without `task`, asks and holds. @param {any} chain @param {string} id @param {{ task?: string }} [opts] */
    async approve(chain, id, opts = {}) {
      const d = await load(id);
      if (d.stage !== "Preview") fail("illegal_transition", `a deployment cannot go from ${d.stage} to Approved`);
      const p = await buildPlan(d);
      if (!opts.task) { await az(chain, "deploy.read", deploymentUrn(space.id, id)); return hold(chain, d, "approve", p, deploymentUrn(space.id, id)); }
      const dec = await decided(opts.task, id, "approve", p.hash);
      const r = transition(d, "Approved", { chain, now: now(), approval: dec.approval, roles: deps.roles, payload_hash: p.hash });
      await deps.store.put(DEP, id, r.deployment);
      await dec.consume();
      await emit(r.events, chain, undefined);
      return { deployment: r.deployment };
    },

    /** Approved -> Production, held for a person. @param {any} chain @param {string} id @param {{ task?: string }} [opts] */
    async publish(chain, id, opts = {}) {
      const d = await load(id);
      const resource = deploymentUrn(space.id, id);
      const authz = await az(chain, "deploy.publish", resource);
      if (d.stage !== "Approved") fail("illegal_transition", `a deployment cannot go from ${d.stage} to Production; it must be approved first`);
      const p = await buildPlan(d);
      if (!opts.task) return hold(chain, d, "publish", p, resource);
      const dec = await decided(opts.task, id, "publish", p.hash);
      const live = (await all()).find(x => x.stage === "Production" && x.name === d.name) || null;
      const r = transition(d, "Production", { chain, now: now(), authz, approval: dec.approval, roles: deps.roles, payload_hash: p.hash, url: p.urls[0], replaces: live });
      await deps.store.put(DEP, id, r.deployment);
      if (r.retired) await deps.store.put(DEP, r.retired.id, r.retired);
      for (const dom of await domains()) if (live && dom.deployment === live.id) await deps.store.put(DOM, dom.host, rebind(dom, id));
      await dec.consume();
      await emit(r.events, chain, authz.decision);
      return { deployment: r.deployment, retired: r.retired || null };
    },

    /** Put the previous version back. `id` is the live deployment. @param {any} chain @param {string} id @param {{ task?: string }} [opts] */
    async rollback(chain, id, opts = {}) {
      const cur = await load(id);
      if (cur.stage !== "Production") fail("not_production", "only the live version can be rolled back");
      const prev = cur.previous ? await deps.store.get(DEP, cur.previous) : null;
      if (!prev) fail("no_previous", "there is no previous version to go back to");
      const resource = deploymentUrn(space.id, prev.id);
      const authz = await az(chain, "deploy.rollback", resource);
      const p = await buildPlan(cur);
      if (!opts.task) return hold(chain, cur, "rollback", p, resource);
      const dec = await decided(opts.task, id, "rollback", p.hash);
      const r = rollbackDeployment(cur, prev, { chain, now: now(), authz, approval: dec.approval, roles: deps.roles, payload_hash: p.hash });
      await deps.store.put(DEP, r.current.id, r.current);
      await deps.store.put(DEP, r.restored.id, r.restored);
      for (const dom of await domains()) if (dom.deployment === cur.id) await deps.store.put(DOM, dom.host, rebind(dom, prev.id));
      await dec.consume();
      await emit(r.events, chain, authz.decision);
      return { deployment: r.restored, retired: r.current };
    },

    /** Take a version down. @param {any} chain @param {string} id */
    async retire(chain, id) {
      const d = await load(id);
      const authz = await az(chain, "deploy.retire", deploymentUrn(space.id, id));
      const r = transition(d, "Retired", { chain, now: now(), authz });
      await deps.store.put(DEP, id, r.deployment);
      await emit(r.events, chain, authz.decision);
      return { deployment: r.deployment };
    },

    /** Start connecting a domain; returns the challenge. @param {any} chain @param {{ host: string, deployment: string, canonical?: "apex" | "www" | null, www?: boolean }} input */
    async addDomain(chain, input) {
      const d = await load(input.deployment);
      await az(chain, "deploy.domain", deploymentUrn(space.id, d.id));
      const r = newDomain({ host: input.host, space: space.id, deployment: d.id, canonical: input.canonical, www: input.www }, { existing: await domains(), now: now(), random: deps.random, limits: deps.domainLimits });
      await deps.store.put(DOM, r.record.host, r.record);
      return r;
    },

    /** @param {any} chain @param {string} host */
    async verifyDomain(chain, host) {
      const rec = (await domains()).find(r => r.host === host);
      if (!rec) fail("not_found", "that domain is not connected");
      await az(chain, "deploy.domain", deploymentUrn(space.id, rec.deployment));
      const r = await checkDomain(rec, { dns: deps.dns, names: deps.names, now: now() });
      if (r.verified) await deps.store.put(DOM, rec.host, r.record);
      return { verified: r.verified, reason: r.reason, record: r.record, ...(r.verified ? {} : { challenge: challengeOf(rec) }) };
    },

    /** @param {any} chain @param {string} host */
    async removeDomain(chain, host) {
      const list = await domains();
      const rec = list.find(r => r.host === host);
      if (!rec) fail("not_found", "that domain is not connected");
      await az(chain, "deploy.domain", deploymentUrn(space.id, rec.deployment));
      dropDomain(list, host);
      await deps.store.delete(DOM, rec.host);
      return { removed: rec.host };
    },

    /**
     * Give one deployment one secret. A real secret is held for a person; `task` resumes it.
     * @param {any} chain @param {string} id @param {{ ref: string, name: string, use?: string[], task?: string }} input
     */
    async grantSecret(chain, id, input) {
      const d = await load(id);
      const cls = await deps.secrets.classOf(input.ref);
      const authz = await az(chain, "deploy.secret", secretUrn(space.id, input.ref));
      const use = input.use && input.use.length ? input.use : ["runtime"];
      // A static site is files and nothing else: a runtime secret would be a file under /run/secrets beside the site, which a link in the site could point to. Build use is fine.
      if (use.includes("runtime") && d.build && d.build.image === "static") fail("isolation", "a static site takes no runtime secrets; it can use a secret to build");
      const p = { action: "grant_secret", deployment: { id: d.id, name: d.name, version: d.version }, secret: { name: input.name, ref: input.ref, class: cls, use }, goes_public: false };
      const hash = sha256hex(canonical(p));
      let approval, consume;
      if (cls === "secret" || authz.effect === "ask") {
        if (!input.task) {
          const t = await deps.ask.request(chain, { title: `Let ${d.name} use ${input.name}`, kind: "grant", action: "deploy.secret", resource: secretUrn(space.id, input.ref), plan: p, payload_hash: hash, approver: d.approver || "owner" });
          await deps.store.put(HOLD, t.id, { task: t.id, deployment: d.id, action: "grant_secret", hash, requested_by: actorOf(chain), created_at: now() });
          return { held: /** @type {true} */ (true), task: t.id, plan: { ...p, hash } };
        }
        const dec = await decided(input.task, id, "grant_secret", hash);
        approval = dec.approval; consume = dec.consume;
      }
      const next = grantSecretTo(d, input.ref, { by: chain, name: input.name, class: cls, use, now: now(), authz, approval, roles: deps.roles, payload_hash: hash });
      await deps.store.put(DEP, id, next);
      if (consume) await consume();
      return { deployment: next };
    },

    /** @param {any} chain @param {string} id @param {string} name */
    async revokeSecret(chain, id, name) {
      const d = await load(id);
      await az(chain, "deploy.secret", deploymentUrn(space.id, id));
      const next = revokeSecret(d, name, now());
      await deps.store.put(DEP, id, next);
      return { deployment: next };
    },

    /** A summary a person or a card can show. No secret values, ever. @param {any} chain @param {string} id */
    async status(chain, id) {
      await az(chain, "deploy.read", deploymentUrn(space.id, id));
      const d = await load(id);
      const doms = (await domains()).filter(r => r.deployment === id).map(r => ({ host: r.host, status: r.status }));
      return {
        id: d.id, name: d.name, version: d.version, stage: d.stage, url: d.url, previous: d.previous,
        build_digest: d.build_digest ?? null, secrets: (d.secrets || []).map((/** @type {any} */ s) => ({ name: s.name, class: s.class, use: s.use })),
        ungranted_env: ungrantedEnv(d), domains: doms, approved_by: d.approved_by ?? null, published_at: d.published_at ?? null,
      };
    },

    /** The generated edge for what is live now: the compose project and the Caddyfile. @param {any} chain */
    async edge(chain) {
      await az(chain, "deploy.read", `vyre://${space.id}/deployment/all`);
      const live = (await all()).filter(d => ["Preview", "Approved", "Production"].includes(d.stage) && d.runtime);
      const workloads = live.map(d => ({
        id: d.id, name: d.name, stage: d.stage, kind: d.runtime.kind,
        ...(d.runtime.kind === "node" ? { image: d.runtime.image, port: d.runtime.port } : {}),
        env: {}, secrets: d.runtime.kind === "static" ? [] : (d.secrets || []).filter((/** @type {any} */ s) => s.use.includes("runtime")).map((/** @type {any} */ s) => s.name),
      }));
      const compose = edgeCompose(space, workloads.map(({ name, stage, ...w }) => ({ ...w, name, stage })));
      const cf = caddyfile(forCaddy(await domains()), workloads, { spaceName: space.name });
      return { compose, caddyfile: cf };
    },

    /** The pipeline Flow for a deployment: the draft shape, or with `kernel` the stored form the Flows runner compiles, approves by hash and runs. @param {string} id @param {{ kernel?: boolean }} [o] */
    async flow(id, o = {}) { const deployment = await load(id); return o.kernel ? publishFlowKernel({ space: space.id, deployment }) : publishFlow({ space: space.id, deployment }); },
  };
}
