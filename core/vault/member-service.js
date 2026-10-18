// @ts-check
// A team member's own Vault on the team's server, for the one thing the first run needs: putting an AI key of theirs in it. A member reaches the server only through the Space's kernel (kernel/remote), so this is a
// SERVICE of that remote server (`services.myvault`, wire.js CALLS.myvault), the way their AI sign-in is (core/sessions/accounts-service.js). Every method is `(chain, input, opts)` with the chain the home's own Surfaces door minted from
// what the transport proved: the person is the chain's one person hop, never anything the request names. `opts.presence` is the person's proof, which the remote server carries only after checking it names this home and this challenge.
//
//   status()                                  { account, unlocked, acct? }: whether their vault exists and is open (no presence, as the tool)
//   addkey({ label, value, password?, secret_key? })   ONE act: make their vault if there is none (password), open it if locked (password and the Secret Key their device holds), choose the item name (the label, else with a number,
//                                              failing closed if their list cannot be read), put it as kind api-key. Covered by ONE presence proof over the label and the value's hash (kernel/remote/proof.js vaultAddKey).
//                                              Returns { item, acct?, secret_key? }: the Secret Key only when the vault was just made, once, to this device. Never the value or the password.
//
// Each call runs the vault's internal tool vault.me.serve, which runs the SAME functions as the vault.me.* tools. Nothing here logs or returns the password, the Secret Key or the value; the proof is carried and never kept.

import { KernelError } from "../../kernel/core/errors.js";
import { proofRequest } from "../../kernel/remote/proof.js";

const CODES = /** @type {Record<string, string>} */ ({ denied: "not_allowed", not_found: "not_found", bad_input: "bad_input", locked: "locked", need_password: "bad_input" });
/** Attempts per member per minute: a key is added by a person, one at a time. */
export const ADDKEY_PER_MINUTE = 10;

/** @param {{ space: string, kernel: any, registry: { call(tool: string, input: any, caller: string, meta?: any): Promise<any> }, clock?: () => number }} o */
export function createMemberVaultService(o) {
  const now = o.clock || Date.now;
  /** @type {Map<string, number[]>} */ const tries = new Map();
  const allow = (/** @type {string} */ person) => {
    const t = now(), list = (tries.get(person) || []).filter((x) => t - x < 60_000);
    if (list.length >= ADDKEY_PER_MINUTE) { tries.set(person, list); return false; }
    list.push(t); tries.set(person, list); return true;
  };
  const who = (/** @type {any} */ chain) => {
    const h = chain && Array.isArray(chain.hops) ? chain.hops : [];
    if (chain?.space !== o.space || chain.viewer === true || chain.delegated === true || h.length !== 1 || !h[0].actor || h[0].actor.kind !== "person") throw new KernelError("not_found", "not found");
    return String(h[0].actor.id);
  };
  const isMember = (/** @type {string} */ person) => {
    try { const r = o.kernel?.gateway?.members?.roleOf({ kind: "person", id: person, space: o.space }); return typeof r === "string" && r !== ""; } catch { return false; }
  };
  const serve = async (/** @type {string} */ call, /** @type {string} */ person, /** @type {any} */ input) => {
    const r = await o.registry.call("vault.me.serve", { call, person, space: o.space, input }, "module:vyred", { door: true });
    if (r && r.error) throw new KernelError(/** @type {any} */ (CODES[r.error.code] || "bad_input"), String(r.error.message || "that did not work"));
    return r.data;
  };
  const member = (/** @type {any} */ chain) => { const person = who(chain); if (!isMember(person)) throw new KernelError("not_found", "not found"); return person; };
  /** The proof for an act on the member's own vault, from the proof name and what it covers: none given asks for one, one that does not stand asks again, nothing is written either way. */
  const proven = async (/** @type {any} */ chain, /** @type {string} */ name, /** @type {any} */ cover, /** @type {any} */ opts) => {
    const want = proofRequest(o.space, name, cover);
    const proof = opts && typeof opts === "object" ? opts.presence : undefined;
    if (!proof) throw new KernelError("needs_presence", "adding keys to your own vault needs you at your device");
    const why = await o.kernel.presence.check({ chain, op: want.op, fields: want.fields, proof });
    if (why !== null) throw new KernelError("needs_presence", "adding keys to your own vault needs you at your device", String(why));
  };
  return {
    async status(/** @type {any} */ chain) { return serve("status", member(chain), {}); },
    async addkey(/** @type {any} */ chain, /** @type {any} */ input, /** @type {any} */ opts) {
      const person = member(chain);
      if (!allow(person)) throw new KernelError("limit", "try again in a minute");
      const i = input && typeof input === "object" && !Array.isArray(input) ? input : {};
      const label = typeof i.label === "string" ? i.label : "", value = typeof i.value === "string" ? i.value : "";
      if (!label || !value) throw new KernelError("bad_input", "that input is not valid");
      // one presence proof for the whole act, over the label and the value's hash: no proof is asked for, a proof that does not stand (wrong hash, used before, expired, another person's) is asked for again; nothing is written either way
      const cover = proofRequest(o.space, "vaultAddKey", { label, value });
      const proof = opts && typeof opts === "object" ? opts.presence : undefined;
      if (!proof) throw new KernelError("needs_presence", "adding a key to your own vault needs you at your device");
      const why = await o.kernel.presence.check({ chain, op: cover.op, fields: cover.fields, proof });
      if (why !== null) throw new KernelError("needs_presence", "adding a key to your own vault needs you at your device", String(why));
      return serve("addkey", person, { label, value, ...(typeof i.password === "string" ? { password: i.password } : {}), ...(typeof i.secret_key === "string" ? { secret_key: i.secret_key } : {}) });
    },
    async addkeys(/** @type {any} */ chain, /** @type {any} */ input, /** @type {any} */ opts) {
      const person = member(chain);
      if (!allow(person)) throw new KernelError("limit", "try again in a minute");
      const i = input && typeof input === "object" && !Array.isArray(input) ? input : {};
      const items = Array.isArray(i.items) ? i.items : [];
      if (!items.length || items.length > 12 || items.some((/** @type {any} */ x) => !x || typeof x.label !== "string" || typeof x.value !== "string" || !x.label || !x.value)) throw new KernelError("bad_input", "that input is not valid");
      await proven(chain, "vaultAddKeys", { items }, opts);
      return serve("addkeys", person, { items: items.map((/** @type {any} */ x) => ({ label: x.label, value: x.value })), ...(typeof i.password === "string" ? { password: i.password } : {}), ...(typeof i.secret_key === "string" ? { secret_key: i.secret_key } : {}) });
    },
  };
}
