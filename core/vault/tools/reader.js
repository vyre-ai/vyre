// @ts-check
// reader: what a member does with an item the owner shared with her at Read, and at Edit and rotate (vault.me.shared.reveal, .update, .rotate). The kernel decides, on HER chain, on the item's address:
// vault.reveal for Read, vault.edit for changing it, vault.rotate for rotating it (kernel/seal/uses.js ACCESS_LEVELS). Fill in carries none of the three. An item she may not act on is not found, in the same
// words as one that does not exist. Each act asks for her own yes on her own device (presence), is logged with who did it, and never goes to an assistant: a chain with an agent in it is refused, and the kernel
// never grants an agent Read or Edit. An api-credential is used only through Vyre and is never shown, changed or rotated here.

import { presence, quoted } from "./presence.js";
import { MEMBER_SURFACES, memberOf } from "./me.js";
import { CONCEAL_AFTER_S } from "./surfaces.js";
import { defaultField } from "../../../lib/vault-kinds/kinds.js";

const str = { type: "string" };
const obj = (properties, required = []) => ({ type: "object", properties, required });
const FIELD = /^[A-Za-z0-9_.-]{1,64}$/;
/** Kinds whose value this path never touches: used only through Vyre, or a signing key that only signs. */
const NEVER = new Set(["api-credential", "passkey"]);
const gone = (/** @type {string} */ item) => Object.assign(new Error(`no item named ${String(item).slice(0, 80)} is shared with you for that`), { code: "not_found" });
const json = (/** @type {any} */ v, /** @type {any} */ d) => { try { return v == null ? d : JSON.parse(String(v)); } catch { return d; } };

/**
 * @param {{ ctx: any, vault: import("../vault.js").Vault, rotateItem: (name: string, who: string) => Promise<any>,
 *   tool: (name: string, callers: string[]|null, description: string, input: any, run: Function, needs?: any) => void }} o
 */
export function register({ ctx, vault, rotateItem, tool }) {
  /** The person, her chain, and the row she may act on at this level: anything else is not found. */
  const may = async (/** @type {any} */ input, /** @type {any} */ meta, /** @type {string} */ action) => {
    const K = /** @type {any} */ (vault).access.K;
    const person = await memberOf(K, meta);
    const name = String((input && input.item) || "");
    const r = /** @type {any} */ (vault.row(name));
    if (!r || NEVER.has(r.kind)) throw gone(name);
    const chain = await K.chain(meta);
    let ok = false;
    try { ok = (await K.authorize({ chain, action, resource: await /** @type {any} */ (vault).access.urn(r.name) })).effect === "allow"; } catch { ok = false; }
    if (!ok) throw gone(name);
    return { person, who: `person:${person}`, r };
  };

  tool("vault.me.shared.reveal", MEMBER_SURFACES, "Show one field of an item the owner shared with you at Read, on your own screen, for a moment. Asks for your yes, and is logged.", obj({ item: str, field: str }, ["item"]),
    async (input, meta) => {
      const { person, who, r } = await may(input, meta, "vault.reveal");
      const have = json(r.fields, []);
      const want = input.field ? String(input.field) : defaultField(r.kind, have) || "value";
      if (!FIELD.test(want)) throw Object.assign(new Error("that is not a field name"), { code: "bad_input" });
      try {
        const f = await vault.fields(r);
        if (typeof f[want] !== "string") throw gone(r.name);
        vault.audit("reveal", r.name, who, true, `field ${want}, shared with ${person}`);
        ctx.events.emit("vault.revealed", { name: r.name, field: want, surface: "member", by: person });
        return { value: f[want], field: want, concealAfter: CONCEAL_AFTER_S };
      } catch (e) {
        if (!(e && /** @type {any} */ (e).code === "not_found")) vault.audit("reveal", r.name, who, false, `field ${want}`);
        throw e;
      }
    },
    presence("Show a shared item", ({ item }) => `Show a field of ${quoted(item)}, shared with you, on this screen`));

  tool("vault.me.shared.update", MEMBER_SURFACES, "Change an item the owner shared with you at Edit and rotate: fields given are replaced, `remove` drops fields. Asks for your yes, and is logged.",
    obj({ item: str, fields: { type: "object" }, remove: { type: "array", items: str }, description: str }, ["item"]),
    async (input, meta) => {
      const { person, who, r } = await may(input, meta, "vault.edit");
      const fields = { .../** @type {Record<string, string>} */ (await vault.fields(r)) };
      for (const [k, v] of Object.entries(input.fields || {})) {
        if (!FIELD.test(k)) throw Object.assign(new Error(`field name "${k}" is not allowed`), { code: "bad_input" });
        if (v === null || v === "") delete fields[k]; else if (typeof v === "string") fields[k] = v; else throw Object.assign(new Error(`field ${k} must be text`), { code: "bad_input" });
      }
      for (const k of input.remove || []) delete fields[String(k)];
      await vault.put({ name: r.name, kind: r.kind, description: input.description === undefined ? r.description : String(input.description).slice(0, 500), fields, url: r.url || undefined, hosts: json(r.hosts, []) }, who);
      vault.audit("edit", r.name, who, true, `shared with ${person}`);
      return { changed: r.name };
    },
    presence("Change a shared item", ({ item }) => `Change ${quoted(item)}, shared with you`));

  tool("vault.me.shared.rotate", MEMBER_SURFACES, "Rotate an item the owner shared with you at Edit and rotate: make a new credential at its provider, store it, revoke the old one. Asks for your yes, and is logged.", obj({ item: str }, ["item"]),
    async (input, meta) => {
      const { who, r } = await may(input, meta, "vault.rotate");
      return rotateItem(r.name, who);
    },
    presence("Rotate a shared item", ({ item }) => `Make a new credential for ${quoted(item)}, shared with you, at its provider, store it, and revoke the old one`));
}
