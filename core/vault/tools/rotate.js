// @ts-check
// vault.rotate: change a credential at its provider and keep the new one, in that order.
//
// rotate.js makes the new credential with the current one. This stores it as a new version first
// (history keeps the old), and only then revokes the old one, so a crash in between leaves the
// vault holding a key that works. A provider with no API for it gets the page and the steps, and
// the person pastes the new value with `vyre vault put`. Values never leave vyred except to the
// provider's own API (ADR 0028).

import { rotate, rotationFor } from "../rotate.js";
import { settle } from "../remind.js";

const json = (v, d) => { try { return v == null ? d : JSON.parse(String(v)); } catch { return d; } };

/**
 * @param {{ vault: import("../vault.js").Vault, tool: Function, presence: Function, quoted: Function, call: Function, endpoints?: Record<string, string> }} deps
 */
export function register({ vault, tool, presence, quoted, call, endpoints }) {
  const obj = (properties, required = []) => ({ type: "object", properties, required });

  tool("vault.rotation", ["cli", "local", "deck", "capsule", "mcp"], "How an item is rotated: automatically through its provider's API, or by hand at the provider's page with the steps. Names only.",
    obj({ name: { type: "string" } }, ["name"]), ({ name }) => {
      const r = vault.mustRow(name);
      const how = rotationFor({ name: r.name, kind: r.kind, details: json(r.details, {}), fields: json(r.fields, []) });
      return how ?? { provider: null, auto: false, steps: `Say which service ${name} belongs to: vyre vault put ${name} --provider <name>, then rotate it.` };
    });

  tool("vault.rotate", ["cli", "local", "deck", "capsule"], "Rotate an item at its provider: make the new credential with the current one, store it as a new version, then revoke the old one. For a provider without an API, returns its page and steps instead.",
    obj({ name: { type: "string" } }, ["name"]), async ({ name }, { caller }) => {
      await vault.key();
      const r = vault.mustRow(name);
      const item = { name: r.name, kind: r.kind, details: json(r.details, {}), fields: json(r.fields, []) };
      const how = rotationFor(item);
      if (!how) throw new Error(`${name} names no provider · vyre vault put ${name} --provider <name>`);
      if (!how.auto) { vault.audit("rotate", name, caller, true, `${how.provider}: guided`); return { rotated: false, guided: how }; }
      const current = await vault.fields(r);
      let made;
      try { made = await rotate(item, current, { fetch: globalThis.fetch, endpoints, now: () => Date.now() }); }
      catch (e) { vault.audit("rotate", name, caller, false, `${how.provider}: ${/** @type {Error} */ (e).message}`); throw e; }
      await vault.put({ name, kind: r.kind, description: r.description, fields: { ...current, ...made.fields }, url: r.url || undefined, hosts: json(r.hosts, []),
        ...(made.expires ? { details: { expires: made.expires } } : {}) }, caller);
      const gone = await made.revoke();
      vault.audit("rotate", name, caller, true, `${how.provider}: new version stored, old ${gone.revoked ? "revoked" : "still live"}`);
      await settle(vault, call, name).catch(() => {});
      return { rotated: true, provider: how.provider, revoked: gone.revoked, ...(gone.reason ? { reason: gone.reason } : {}), ...(made.expires ? { expires: made.expires } : {}) };
    }, presence("Rotate a credential", ({ name }) => `Make a new credential for ${quoted(name)} at its provider, store it, and revoke the old one`));
}
