// @ts-check
// lib/publish/grants.js: a deployment's secrets are kernel grants (one grant model): `vault.run` on the credential, to the deployment's own service actor, made by the Publish module inside its manifest's
// `needs.kernel.mints`. The deployment record no longer carries them. `withSecretGrants` is the store the publisher sees: a read adds `secrets` from the kernel, and a write makes the grants the record
// names that the kernel does not hold, ends the ones it no longer names, and stores the record without the field. A record that still has the old list (made before this) is moved the first time it is written.
import { deploymentUrn } from "./util.js";

const PREFIX = "publish:secret:";
const credentialUrn = (/** @type {string} */ space, /** @type {string} */ ref) => `vyre://${space}/credential/${ref.replace(/^vault:\/\//, "")}`;
const sourceOf = (/** @type {string} */ dep, /** @type {any} */ s) => `${PREFIX}${dep}:${s.name}:${s.class}:${s.use.join("+")}`;

/** @param {string} space @param {any} g a kernel grant @returns {any} the entry the deployment shows */
function entryOf(space, g) {
  const [, , dep, name, cls, use] = String(g.source).split(":");
  return { name, ref: `vault://${g.resource.prefix.slice(`vyre://${space}/credential/`.length)}`, class: cls, use: use.split("+"), granted_by: String(g.reason || "").replace(/^granted by /, ""), granted_at: g.created_at, resource: deploymentUrn(space, dep), grant: g.id };
}

/**
 * @param {{ get(coll: string, id: string): Promise<any>, put(coll: string, id: string, v: any): Promise<void>, delete(coll: string, id: string): Promise<void>, list(coll: string): Promise<any[]> }} store
 * @param {{ list(source: string): Promise<any[]>, make(i: any): Promise<string>, end(q: { id: string, reason?: string }): Promise<any> }} grants
 * @param {string} space
 */
export function withSecretGrants(store, grants, space) {
  const held = async (/** @type {string} */ dep) => (await grants.list(`${PREFIX}${dep}:`)).map(g => entryOf(space, g));
  const hydrate = async (/** @type {any} */ d) => {
    if (!d || !d.id) return d;
    const made = await held(d.id), legacy = (Array.isArray(d.secrets) ? d.secrets : []).filter((/** @type {any} */ s) => !made.some((/** @type {any} */ m) => m.name === s.name));
    return { ...d, secrets: [...made, ...legacy] };
  };
  return {
    async get(/** @type {string} */ coll, /** @type {string} */ id) { const d = await store.get(coll, id); return coll === "deployments" ? hydrate(d) : d; },
    async list(/** @type {string} */ coll) { const l = await store.list(coll); return coll === "deployments" ? Promise.all(l.map(hydrate)) : l; },
    async put(/** @type {string} */ coll, /** @type {string} */ id, /** @type {any} */ v) {
      if (coll !== "deployments" || !v || !Array.isArray(v.secrets)) return store.put(coll, id, v);
      const have = await held(id);
      // grants first, the record after: a crash between leaves both, and the next write finds the grants and only strips the record
      for (const s of v.secrets) if (!have.some((/** @type {any} */ h) => h.name === s.name)) await grants.make({ subject: { kind: "actor", actor: { kind: "service", id: `deployment-${id}`, space } }, actions: ["vault.run"], resource: { prefix: credentialUrn(space, s.ref) }, source: sourceOf(id, s), reason: `granted by ${s.granted_by}` });
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
