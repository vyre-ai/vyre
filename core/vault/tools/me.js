// @ts-check
// me: a member's own vault (the owner's decisions of 13 Oct). The tools act on the vault of the person the kernel names for the call, never on one the input names: there is no `person` or `vault` field to give.
// Not for the owner, whose vault is the vault.* tools; not for a model, which sees names and kinds at most in a session (the values go to the person's surfaces and to the module that holds the sign-in).
// The member gate lets these names through (MEMBER_ALLOWED) because each one resolves its person here and refuses anything but exactly one person who is not the owner.

import { devSwitch } from "../../../kernel/devbuild.js";   // a development build only: a fake vendor on loopback (VYRE_SEAL_DEV=1); a packaged build ignores it
import { refuseNonPerson } from "../../../lib/person-body.js";
import { PERSON_SURFACES as THE_SURFACES } from "../../../lib/person-surfaces.js";
import { presence } from "./presence.js";
import { freeItemName, itemNameOf } from "../../../lib/vault-item-name.js";
import { ConnectionTokens, revokeAllowed } from "../connection-token.js";
import { normalize as normalizeApiCredential } from "../api-request.js";
import { revokeAtVendor } from "../connection-revoke.js";

/** The surfaces of a person: a model's labels (mcp, harness, agents) are not among them. */
const PERSON_SURFACES = [...THE_SURFACES, "device", "web"];
const obj = (properties, required = []) => ({ type: "object", properties, required });
const str = { type: "string" };
const fields = { type: "object", additionalProperties: { type: "string" } };

/** The kinds of item a member keeps an AI account's credential in. */
const AI_KINDS = ["api-key", "setup-token", "secret"];
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

/** Modules-only tools on a member's own vault (reach modules, never a person's surface or a model): the gate lets them through, each one resolves its person from the chain. */
/** The two tools with which a member uses what the owner shared with her (registered in core/vault/request.js, beside vault.request, which they run through). */
export const SHARED_ME_TOOLS = ["vault.me.mention.search", "vault.me.mention.resolve", "vault.me.shared.reveal", "vault.me.shared.update", "vault.me.shared.rotate", "vault.me.provisioned", "vault.me.vaults", "vault.me.shared.list", "vault.me.shared.request", "vault.me.connection.share", "vault.me.connection.shares", "vault.me.connection.directory"];
/** The surfaces a member's own session comes in through (a model's labels are not among them). */
export const MEMBER_SURFACES = PERSON_SURFACES;

export const ME_MODULE_TOOLS = ["vault.me.release", "vault.me.has", "vault.me.serve", "vault.me.lend", "vault.connection.token", "vault.connection.revoke", "vault.me.connect.put", "vault.me.who"];

/**
 * @param {{ ctx: any, people: import("../people.js").PeopleVaults,
 *   tool: (name: string, callers: string[]|null, description: string, input: any, run: Function, needs?: any) => void }} o
 */
export function register({ ctx, people, tool, onRemoved = async () => {} }) {
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
    obj({ name: str, kind: str, description: str, fields }, ["name", "fields"]), mine((id, i) => { if (String(i.kind) === "api-credential") { try { normalizeApiCredential(JSON.parse(String(i.fields && i.fields.config || ""))); } catch (e) { throw Object.assign(new Error(`an API credential needs a valid config: ${String(/** @type {Error} */ (e).message).slice(0, 120)}`), { code: "bad_input" }); } } return people.put(id, i); }),
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
  tool("vault.me.remove", PERSON_SURFACES, "Delete an item of your own vault.", obj({ name: str }, ["name"]), mine(async (id, i) => { const conn = await people.service(id).has(String(i.name)).catch(() => false); const r = await people.remove(id, i); if (conn) await onRemoved(id, String(i.name)); return r; }),
    presence("Delete an item of your own vault", ({ name }) => `Delete ${String(name).slice(0, 64)} from your own vault`));
  // One field of one of the member's own items, handed to the module that uses it for her (files: her Dropbox token for a linked folder). Modules only (reach "modules", like vault.release), only the
  // module and item named here, and only for the one person in the call's chain: no `person` input, so the owner's vault and another member's are out of reach, and an agent's turn is refused.
  // A member's own AI key or setup token, for the account row that names it. `has` answers only whether the named item is in that person's vault (the add-time check, never a value); it is for the sessions module.
  // `lend` takes the ACCOUNT only and works out the person from the verified chain of the turn the call is made in: it gives the one item that account names, to the Switchboard, for that member's own turn, and
  // only when the account row is theirs and their vault is unlocked. The value goes into the session's environment and nowhere else: never an event, a log line, an error or an audit row.
  // The member door's own call (core/vault/member-service.js, wire.js CALLS.myvault): the person is the one the door's chain names. Only the daemon's door runs it, never a person's surface and never a model. It runs the same
  // functions as the vault.me.* tools, for the five calls the first run needs, with the input cut to exactly what each takes. The password, the Secret Key and the value are used for that one call and are never logged or returned.
  ctx.tool("vault.me.serve", {
    internal: true,
    description: "A team member's own Vault, as the member's own chain from the team's door: status, and addkey (make the vault if none, open it if locked, put one AI key under a free name). Only the daemon's own door runs it, after the member's presence proof was checked there.",
    input: obj({ call: str, person: str, space: str, input: { type: "object" } }, ["call", "person", "space"]),
    run: async (/** @type {any} */ i, /** @type {any} */ meta) => {
      if (String((meta && meta.caller) || "") !== "module:vyred") throw Object.assign(new Error(ME_REFUSAL), { code: "denied" });
      const id = String(i.person);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id) || id === String(ctx.kernel && ctx.kernel.owner)) throw Object.assign(new Error(ME_REFUSAL), { code: "denied" });
      const input = i.input && typeof i.input === "object" && !Array.isArray(i.input) ? i.input : {};
      const bad = (/** @type {string} */ m) => Object.assign(new Error(m), { code: "bad_input" });
      const text = (/** @type {unknown} */ v, /** @type {number} */ max) => { const t = typeof v === "string" ? v : ""; if (!t || t.length > max) throw bad("that input is not valid"); return t; };
      switch (String(i.call)) {
        case "status": return people.status(id);
        case "addkey": {
          const label = text(input.label, 80);
          if (/[\u0000-\u001f]/.test(label)) throw bad("a name is one line");
          const value = text(input.value, 400);
          if (value.length < 12 || /[\s\u0000-\u001f\u007f]/.test(value)) throw bad("that does not look like an API key");
          const st = await people.status(id);
          /** @type {string | undefined} */ let secretKey;
          if (!st.account) {
            // no vault yet: made with their password, opened at once with the Secret Key it returns (which goes back to their device, once, below)
            const pw = typeof input.password === "string" && input.password ? text(input.password, 1024) : "";
            if (!pw) throw bad("your password is needed to make your own vault");
            const made = await people.create(id, { password: pw });
            secretKey = made && typeof made.secretKey === "string" ? made.secretKey : undefined;
            if (!secretKey) throw bad("your vault could not be made");
            await people.unlock(id, { password: pw, secretKey });
          } else if (!st.unlocked) {
            await people.unlock(id, { password: text(input.password, 1024), secretKey: text(input.secret_key, 256) });
          }
          // The vault now exists: whatever goes wrong below, its Secret Key reaches the device (a vault made and never given its key could not be opened again). A failure after the vault was made is answered as a result with no item,
          // the reason in plain words, and the Secret Key (the one field it ever travels in); a failure before that throws as usual.
          const finish = async () => {
            // the item's name: the label when free in THEIR vault, else with a number; a put on a name that exists replaces that item, so a list that cannot be read puts nothing
            let rows; try { const l = await people.list(id, {}); rows = Array.isArray(l) ? l : l && Array.isArray(l.items) ? l.items : null; } catch { rows = null; }
            if (!rows) throw bad("your vault could not be checked for that name");
            const used = new Set(rows.map((/** @type {any} */ x) => String(x && x.name || "").toLowerCase()));
            // the Vault's names are letters, digits, dot, dash and underscore: the label is kept as itemNameOf makes it, with -2, -3 when taken
            const item = freeItemName(itemNameOf(label), used);
            if (!item) throw bad("that name is taken in your vault");
            await people.put(id, { name: item, kind: "api-key", description: "", fields: { value } });
            return item;
          };
          let item = "", failed = "";
          try { item = await finish(); } catch (e) { if (!secretKey) throw e; failed = String(/** @type {any} */ (e).message || "your key could not be put in your vault").slice(0, 200); }
          const after = await people.status(id);
          return { item, ...(failed ? { failed } : {}), ...(after.acct ? { acct: after.acct } : {}), ...(secretKey ? { secret_key: secretKey } : {}) };
        }
        default: throw bad("call is status or addkey");
      }
    },
  });
  ctx.tool("vault.me.has", {
    internal: true,
    description: "Whether a member's own vault holds an AI key or setup token by this name: { name } -> { has }. Only the sessions module asks, at the moment a member adds the account, and the person is the one on the call's verified chain, never the input (a `person` in the input is ignored). Never a value.",
    input: obj({ person: str, name: str }, ["name"]),
    run: async (/** @type {any} */ input, /** @type {any} */ meta) => {
      if (String((meta && meta.caller) || "") !== "module:sessions") throw Object.assign(new Error(ME_REFUSAL), { code: "denied" });
      const person = await memberOf(ctx.kernel, meta);   // the chain's person, as lend does; the owner and a chain that cannot be named are refused there
      let items; try { items = await people.list(person, {}); } catch { throw Object.assign(new Error("unlock your own vault first, then add the account"), { code: "denied" }); }
      return { has: (items.items || items).some((/** @type {any} */ x) => x.name === String(input.name) && AI_KINDS.includes(String(x.kind))) };
    },
  });
  ctx.tool("vault.me.lend", {
    internal: true,
    description: "A member's own AI key or setup token for one of their accounts, to start their own turn: { account } -> { value }. Only the chat module (threads) asks, inside the member's own turn; the person is the one on the turn's verified chain, never named. Refused unless the account is theirs and their vault is unlocked.",
    input: obj({ account: str }, ["account"]),
    run: async (/** @type {any} */ input, /** @type {any} */ meta) => {
      if (String((meta && meta.caller) || "") !== "module:threads") throw Object.assign(new Error(ME_REFUSAL), { code: "denied" });   // the Switchboard's module is named `threads`; its calls arrive with that label
      const person = await memberOf(ctx.kernel, meta);
      const row = await ctx.call("sessions.accounts.item", { account: String(input.account || ""), person });
      const acct = row && !row.error ? row.data : null;
      if (!acct || typeof acct.item !== "string" || !AI_KINDS.includes(String(acct.kind || ""))) throw Object.assign(new Error("that account is not yours, or holds no key of yours: pick one of your own AI accounts, or add your key to it first"), { code: "denied" });
      let it; try { it = await people.get(person, { name: acct.item }); } catch { throw Object.assign(new Error("unlock your own vault to use this account"), { code: "locked" }); }
      const value = it.fields[String(acct.field || "value")] ?? it.fields.key ?? it.fields.token;
      if (typeof value !== "string" || !value) throw Object.assign(new Error("the key in your vault for this account is empty: add the key to the account in your vault, then try again"), { code: "denied" });
      people.emit("vault.me.lent", { person, account: String(input.account) });   // who and which account: never the value, and never the item's name (the member's own label for a secret)
      return { value };
    },
  });
  const RELEASE_TO = /** @type {Record<string, string[]>} */ ({ "module:files": ["dropbox"] });
  ctx.tool("vault.me.release", {
    internal: true,
    description: "One field of a member's own item, to the module that uses it for her: { name, field? } -> { person, value }. Only files, only her Dropbox item. Modules only.",
    input: obj({ name: str, field: str }, ["name"]),
    run: async (/** @type {any} */ input, /** @type {any} */ meta) => {
      const allowed = RELEASE_TO[String((meta && meta.caller) || "")];
      if (!allowed || !allowed.includes(String(input && input.name))) throw Object.assign(new Error(ME_REFUSAL), { code: "denied" });
      const id = await memberOf(ctx.kernel, meta);
      const it = await people.get(id, { name: String(input.name) });
      const value = it.fields[String(input.field || "value")];
      if (typeof value !== "string" || !value) throw new Error(`no ${String(input.field || "value")} on ${input.name}`);
      return { person: id, value };
    },
  });
  // Who is asking, for the modules that make a row for the asker (mcp.add): the Space owner, or the one member in the chain. Nothing else: an assistant in the chain, two people, an unreadable
  // chain or a model's label all answer denied, so a caller that cannot be named is never treated as the owner. The person is the chain's, never the input's.
  ctx.tool("vault.me.who", {
    internal: true,
    description: "Who this call is made for: { kind: \"owner\" } or { kind: \"member\", person }. Only the mcp and connectors modules ask.",
    input: obj({}),
    run: async (/** @type {any} */ _input, /** @type {any} */ meta) => {
      if (!["module:mcp", "module:connectors"].includes(String((meta && meta.caller) || ""))) throw Object.assign(new Error(ME_REFUSAL), { code: "denied" });
      const K = ctx.kernel;
      let c;
      try { c = await K.chain(meta || {}); } catch { throw Object.assign(new Error("who is asking could not be read: sign in again on this device, then try again"), { code: "denied" }); }
      const hops = c && Array.isArray(c.hops) ? c.hops : [];
      if (hops.some((/** @type {any} */ h) => h && h.actor && h.actor.kind !== "person")) throw Object.assign(new Error("an assistant is not a person: ask as yourself"), { code: "denied" });
      const ids = [...new Set(hops.filter((/** @type {any} */ h) => h && h.actor && h.actor.kind === "person").map((/** @type {any} */ h) => String(h.actor.id)))];
      if (ids.length !== 1) throw Object.assign(new Error("one person is asking, or none is: ask from your own signed-in session, with no assistant between"), { code: "denied" });
      return String(K.owner) === ids[0] ? { kind: "owner" } : { kind: "member", person: ids[0] };
    },
  });

  // The connectors module stores a finished sign-in as an item of kind "connection" in the vault of the person who signed in, never in the owner's and never for a person the input names. The person
  // is the chain's; connected_by is set here from it, so a caller cannot label a connection as another person's. A new connection is made, an existing one of the same name is updated (a refresh).
  const CONNECTION_KINDS = ["oauth", "bearer", "api_key"];
  ctx.tool("vault.me.connect.put", {
    internal: true,
    description: "Store a connection (a finished app sign-in or a pasted token) in the signed-in member's own vault: { name, fields } -> { name, created }. Only the connectors and mcp modules (a token a member pastes for her own server); the person is the call's chain.",
    input: obj({ name: str, fields }, ["name", "fields"]),
    run: async (/** @type {any} */ input, /** @type {any} */ meta) => {
      if (!["module:connectors", "module:mcp"].includes(String((meta && meta.caller) || ""))) throw Object.assign(new Error(ME_REFUSAL), { code: "denied" });
      const id = await memberOf(ctx.kernel, meta);
      const f = input && input.fields;
      if (!f || typeof f !== "object" || !CONNECTION_KINDS.includes(String(f.auth_kind))) throw Object.assign(new Error("a connection needs auth_kind: oauth, bearer or api_key"), { code: "bad_input" });
      if (typeof f.server_url !== "string" || !(/^https:\/\//.test(f.server_url) || (devSwitch(process.env.VYRE_SEAL_DEV) && /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(f.server_url)))) throw Object.assign(new Error("a connection needs the https address of its server (server_url)"), { code: "bad_input" });
      const fields = { ...f, connected_by: id };
      const svc = people.service(id), name = String(input.name);
      if (await svc.has(name)) {
        const cur = await svc.get(name);
        if (cur.fields.connected_by && cur.fields.connected_by !== id) throw Object.assign(new Error("that name is not a connection of yours: choose another name, or connect the app again under your own name"), { code: "denied" });
      } else {
        // A name an ordinary item of hers already has is refused (checked when her vault is open; a sealed-only call cannot see ordinary items, which the connection key does not open).
        let clash = false;
        try { clash = (await people.list(id, {})).items.some((/** @type {any} */ i) => i.name === name); } catch (e) { if (/** @type {any} */ (e).code !== "locked") throw e; }
        if (clash) throw Object.assign(new Error("that name is not a connection of yours: choose another name, or connect the app again under your own name"), { code: "denied" });
      }
      return svc.put(name, `connection to ${new URL(f.server_url).host}`, fields);
    },
  });

  // A person's app connection, for the MCP hub only: an access token for one connection in the OWNER'S vault, named by the hub row (never by a model), after a second check of who is asking
  // (core/vault/connection-token.js). The refresh token stays here. The tool is not for a person's surface or a model.
  const tokens = new ConnectionTokens({ people, kernel: () => ctx.kernel });
  ctx.tool("vault.connection.token", {
    internal: true,
    description: "An access token for one person's app connection, for the MCP hub: { owner, connection, write? } -> { access_token, token_type, expires_at, resource }. Only the mcp module asks; the asker's chain is checked again.",
    input: obj({ owner: str, connection: str, write: { type: "boolean" }, as: str }, ["owner", "connection"]),
    run: async (/** @type {any} */ input, /** @type {any} */ meta) => {
      if (String((meta && meta.caller) || "") !== "module:mcp") throw Object.assign(new Error(ME_REFUSAL), { code: "denied" });
      return tokens.token(input || {}, meta);
    },
  });
  // The person took the connection away (the hub asks, after it checked they are the one who made it): tell the vendor to drop the token where the connection says how. Only the mcp module asks; nothing comes back but whether it was revoked.
  ctx.tool("vault.connection.revoke", {
    internal: true,
    description: "Tell the vendor to revoke a person's connection token (RFC 7009), if the connection names a revocation address: { owner, connection } -> { revoked, why }. Only the mcp module asks, after it checked the caller made the connection.",
    input: obj({ owner: str, connection: str, as: str }, ["owner", "connection"]),
    run: async (/** @type {any} */ input, /** @type {any} */ meta) => {
      if (String((meta && meta.caller) || "") !== "module:mcp") throw Object.assign(new Error(ME_REFUSAL), { code: "denied" });
      const owner = String(input && input.owner || ""), name = String(input && input.connection || "");
      if (!revokeAllowed(owner, input && input.as)) throw Object.assign(new Error("only the person who made a connection takes it away: ask them to remove it"), { code: "denied" });
      if (!/^per_[A-Za-z0-9_-]{1,64}$/.test(owner) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) throw Object.assign(new Error("name the person and the connection"), { code: "bad_input" });
      // the connection's own fields (its revocation address and refresh token) are read the way the token tool reads them, by the connection key or the server's sealed copy; the person-facing get shows no secret and would never name the address
      const out = await revokeAtVendor({ people: { get: (/** @type {string} */ id, /** @type {{ name: string }} */ q) => people.service(id).get(q.name) } }, { owner, connection: name });
      return out;
    },
  });
}
