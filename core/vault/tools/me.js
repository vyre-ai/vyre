// @ts-check
// me: a member's own vault (the owner's decisions of 13 Oct). The tools act on the vault of the person the kernel names for the call, never on one the input names: there is no `person` or `vault` field to give.
// Not for the owner, whose vault is the vault.* tools; not for a model, which sees names and kinds at most in a session (the values go to the person's surfaces and to the module that holds the sign-in).
// The member gate lets these names through (MEMBER_ALLOWED) because each one resolves its person here and refuses anything but exactly one person who is not the owner.

import { refuseNonPerson } from "../../../lib/person-body.js";
import { PERSON_SURFACES as THE_SURFACES } from "../../../lib/person-surfaces.js";
import { presence } from "./presence.js";

/** The surfaces of a person: a model's labels (mcp, harness, agents) are not among them. */
const PERSON_SURFACES = [...THE_SURFACES, "device", "web"];
const obj = (properties, required = []) => ({ type: "object", properties, required });
const str = { type: "string" };
const fields = { type: "object", additionalProperties: { type: "string" } };

export const ME_REFUSAL = "this is a member's own vault: it is for a signed-in member, and the owner uses the vault tools";

/**
 * The one person this call is made for, from the kernel's chain. Refuses: no kernel, an unreadable chain, no person, more than one distinct person, the owner.
 * @param {any} kernel @param {any} meta @returns {Promise<string>}
 */
export async function memberOf(kernel, meta) {
  const refuse = () => Object.assign(new Error(ME_REFUSAL), { code: "denied" });
  if (!kernel || typeof kernel.chain !== "function" || !kernel.owner) throw refuse();
  let c;
  try { c = await kernel.chain(meta || {}); } catch { throw refuse(); }
  // An agent's turn is not the person at the keyboard: a chain with an agent in it is refused (default deny).
  if ((c && Array.isArray(c.hops) ? c.hops : []).some((/** @type {any} */ h) => h && h.actor && h.actor.kind === "agent")) throw refuse();
  const ids = new Set((c && Array.isArray(c.hops) ? c.hops : []).filter((/** @type {any} */ h) => h && h.actor && h.actor.kind === "person").map((/** @type {any} */ h) => String(h.actor.id)));
  if (ids.size !== 1) throw refuse();
  const [id] = [...ids];
  if (id === String(kernel.owner)) throw refuse();
  return id;
}

/** The names this file registers: the member gate lets exactly these through. */
export const ME_TOOLS = ["vault.me.account.create", "vault.me.account.unlock", "vault.me.account.reset", "vault.me.account.lock", "vault.me.account.status",
  "vault.me.put", "vault.me.get", "vault.me.list", "vault.me.update", "vault.me.remove",
  "vault.me.store.get", "vault.me.store.put", "vault.me.store.list", "vault.me.store.remove"];

/**
 * @param {{ ctx: any, people: import("../people.js").PeopleVaults,
 *   tool: (name: string, callers: string[]|null, description: string, input: any, run: Function, needs?: any) => void }} o
 */
export function register({ ctx, people, tool }) {
  /** @param {(id: string, input: any, meta: any) => any} fn */
  const mine = fn => async (/** @type {any} */ input, /** @type {any} */ meta) => fn(await memberOf(ctx.kernel, meta), input || {}, meta);

  tool("vault.me.account.create", PERSON_SURFACES, "Make your own vault: set a master password. Returns your Secret Key once; your device keeps it, this server never does.",
    obj({ password: str }, ["password"]), mine((id, i) => people.create(id, i)),
    presence("Make your own vault", () => "Set a master password for your own vault"));
  tool("vault.me.account.unlock", PERSON_SURFACES, "Unlock your own vault with your master password and the Secret Key your device holds.",
    obj({ password: str, secretKey: str }, ["password", "secretKey"]), mine((id, i) => people.unlock(id, i)));
  tool("vault.me.account.reset", PERSON_SURFACES, "Set a new master password with the recovery secret from your kit, for a forgotten password.",
    obj({ recovery: str, password: str }, ["recovery", "password"]), mine((id, i) => people.reset(id, i)),
    presence("Set a new password for your own vault", () => "Set a new password for your own vault with your recovery kit"));
  tool("vault.me.account.lock", PERSON_SURFACES, "Lock your own vault now.", obj({}), mine(id => people.lock(id)));
  tool("vault.me.account.status", PERSON_SURFACES, "Whether you have a vault here and whether it is unlocked.", obj({}), mine(id => people.status(id)));

  tool("vault.me.put", PERSON_SURFACES, "Add an item to your own vault (an AI sign-in, a mail or calendar connection, a note).",
    obj({ name: str, kind: str, description: str, fields }, ["name", "fields"]), mine((id, i) => people.put(id, i)),
    presence("Add an item to your own vault", ({ name }) => `Add ${String(name).slice(0, 64)} to your own vault`));
  tool("vault.me.get", PERSON_SURFACES, "Read one item of your own vault, value included.", obj({ name: str }, ["name"]), mine((id, i) => people.get(id, i)),
    presence("Read an item of your own vault", ({ name }) => `Show ${String(name).slice(0, 64)} from your own vault`));
  tool("vault.me.list", PERSON_SURFACES, "The names and kinds in your own vault. Never a value.", obj({ filter: str }), mine((id, i) => people.list(id, i)));
  tool("vault.me.update", PERSON_SURFACES, "Change an item of your own vault.", obj({ name: str, description: str, fields }, ["name"]), mine((id, i) => people.update(id, i)),
    presence("Change an item of your own vault", ({ name }) => `Change ${String(name).slice(0, 64)} in your own vault`));
  // The JSON store other modules use for a member's own entries (people.js personalStore): the mcp module and the space list call these with the member's inherited token.
  const store = (/** @type {string} */ id) => people.personalStore(id);
  // A module (mcp, the space list) may call the store on the member's own turn: its hop inherits the member's token, so memberOf finds the one person in the chain. A module call with no person in its chain, or with an agent hop, is refused there.
  const STORE_CALLERS = [...PERSON_SURFACES, "module"];
  // Only the named modules that keep a member's entries here (mcp: the MCP servers she brought): another module, even one holding her inherited token, is refused. The space list is the app's own call, not a module's.
  const STORE_MODULES = new Set(["module:mcp"]);
  const storeOnly = (/** @type {(id: string, i: any) => any} */ fn) => async (/** @type {any} */ input, /** @type {any} */ meta) => {
    refuseNonPerson(meta, "uses a member's own store");
    const caller = String((meta && meta.caller) || "");
    if (caller.startsWith("module:") && !STORE_MODULES.has(caller)) throw Object.assign(new Error(ME_REFUSAL), { code: "denied" });
    return mine(fn)(input, meta);
  };
  const value = { description: "any JSON value up to 64 KB" };
  tool("vault.me.store.get", STORE_CALLERS, "Read one entry of your own store (a JSON value under a key), or null.", obj({ key: str }, ["key"]), storeOnly((id, i) => store(id).get(i.key)));
  tool("vault.me.store.put", STORE_CALLERS, "Write one entry of your own store.", obj({ key: str, value }, ["key", "value"]), storeOnly(async (id, i) => { await store(id).put(i.key, i.value); return { key: i.key, stored: true }; }));
  tool("vault.me.store.list", STORE_CALLERS, "Every entry of your own store.", obj({}), storeOnly(id => store(id).list()));
  tool("vault.me.store.remove", STORE_CALLERS, "Delete one entry of your own store.", obj({ key: str }, ["key"]), storeOnly(async (id, i) => ({ removed: await store(id).remove(i.key) })));
  tool("vault.me.remove", PERSON_SURFACES, "Delete an item of your own vault.", obj({ name: str }, ["name"]), mine((id, i) => people.remove(id, i)),
    presence("Delete an item of your own vault", ({ name }) => `Delete ${String(name).slice(0, 64)} from your own vault`));
}
