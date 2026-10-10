// @ts-check
// lib/publish/grants.js: a deployment's secrets are kernel grants (one grant model): `vault.run` on the credential, to the deployment's own service actor, made by the Publish module inside its manifest's
// `needs.kernel.mints`. The deployment record no longer carries them. `withSecretGrants` is the store the publisher sees: a read adds `secrets` from the kernel, and a write makes the grants the record
// names that the kernel does not hold, ends the ones it no longer names, and stores the record without the field. A record that still has the old list (made before this) is moved the first time it is written.
import { deploymentUrn } from "./util.js";
import { credentialUrn } from "../../kernel/contracts/index.js";

const PREFIX = "publish:secret:";

/** The grant's source says what it is for and who gave it: publish:secret:<deployment>:<name>:<class>:<use>:<person>. */
const sourceOf = (/** @type {string} */ dep, /** @type {any} */ s) => `${PREFIX}${dep}:${s.name}:${s.class}:${s.use.join("+")}:${s.granted_by}`;

/** @param {string} space the deployment's Space @param {string} kspace the kernel's own Space, where the credential and its grants live @param {any} g a kernel grant @returns {any} the entry the deployment shows */
function entryOf(space, kspace, g) {
  const [, , dep, name, cls, use, by] = String(g.source).split(":");
  return { name, ref: `vault://${g.resource.prefix.slice(`vyre://${kspace}/credential/`.length)}`, class: cls, use: use.split("+"), granted_by: by || "", granted_at: g.created_at, resource: deploymentUrn(space, dep), grant: g.id };
}

/**
 * @param {{ get(coll: string, id: string): Promise<any>, put(coll: string, id: string, v: any): Promise<void>, delete(coll: string, id: string): Promise<void>, list(coll: string): Promise<any[]> }} store
 * @param {{ list(source: string): Promise<any[]>, make(i: any): Promise<string>, end(q: { id: string, reason?: string }): Promise<any> }} grants
 * @param {string} space the deployment's Space (Publish's own tables are keyed by it)
 * @param {() => string | undefined} [kernelSpace] the kernel's own Space. A credential is the Vault's, in the kernel the Vault runs in, so its address and the deployment's actor say that Space, as Wink's grants do; a deployment made in a created Space still names its own Space on the deployment.
 */
export function withSecretGrants(store, grants, space, kernelSpace = () => space) {
  const ks = () => kernelSpace() || space;
  const held = async (/** @type {string} */ dep) => (await grants.list(`${PREFIX}${dep}:`)).map(g => entryOf(space, ks(), g));
  const hydrate = async (/** @type {any} */ d) => {
    if (!d || !d.id) return d;
    const made = await held(d.id), legacy = (Array.isArray(d.secrets) ? d.secrets : []).filter((/** @type {any} */ s) => !made.some((/** @type {any} */ m) => m.name === s.name));
    return { ...d, secrets: [...made, ...legacy] };
  };
  return {
    async get(/** @type {string} */ coll, /** @type {string} */ id) { const d = await store.get(coll, id); return coll === "deployments" ? hydrate(d) : d; },
    async list(/** @type {string} */ coll) { const l = await store.list(coll); return coll === "deployments" ? Promise.all(l.map(hydrate)) : l; },
    /** `opts.secrets === "apply"` is the one way a write makes or ends grants (granting, taking away, the move of an old record). Any other write keeps the record's secrets out of its body and leaves the grants alone, so a stale copy of a record (a build that read it minutes ago) can never bring back a secret that was taken away. */
    async put(/** @type {string} */ coll, /** @type {string} */ id, /** @type {any} */ v, /** @type {{ secrets?: "apply" }} */ opts = {}) {
      if (coll !== "deployments" || !v || !Array.isArray(v.secrets)) return store.put(coll, id, v);
      if (opts.secrets !== "apply") {
        const { secrets: _stale, ...rest } = v;
        const was = await store.get(coll, id);
        // an old record's own list stays as it is until the move has made its grants
        return store.put(coll, id, was && Array.isArray(was.secrets) ? { ...rest, secrets: was.secrets } : rest);
      }
      const have = await held(id);
      // grants first, the record after: a crash between leaves both, and the next write finds the grants and only strips the record
      for (const s of v.secrets) if (!have.some((/** @type {any} */ h) => h.name === s.name)) await grants.make({ subject: { kind: "actor", actor: { kind: "service", id: `deployment-${id}`, space: ks() } }, actions: ["vault.run"], resource: { prefix: credentialUrn(ks(), s.ref) }, source: sourceOf(id, s), reason: `granted by ${s.granted_by}` });
      for (const h of have) if (!v.secrets.some((/** @type {any} */ s) => s.name === h.name)) await grants.end({ id: h.grant, reason: "taken away from the deployment" });
      const { secrets: _gone, ...rest } = v;
      return store.put(coll, id, rest);
    },
    async delete(/** @type {string} */ coll, /** @type {string} */ id) {
      if (coll === "deployments") for (const h of await held(id)) await grants.end({ id: h.grant, reason: "the deployment was removed" });
      return store.delete(coll, id);
    },
  };
}

/**
 * The one-time move on the first start after the update (the update backs up before it restarts): every deployment record in `raw` that still carries a secrets list is written through `store`,
 * which makes its grants and strips the field. Nothing else is touched; a second run finds no list and does nothing.
 * @param {{ list(coll: string): Promise<any[]> }} raw @param {{ put(coll: string, id: string, v: any, opts?: { secrets?: "apply" }): Promise<void> }} store @returns {Promise<number>} deployments moved
 */
export async function moveSecretsToGrants(raw, store) {
  let moved = 0;
  for (const d of await raw.list("deployments")) if (d && d.id && Array.isArray(d.secrets)) { await store.put("deployments", d.id, d, { secrets: "apply" }); moved++; }
  return moved;
}
