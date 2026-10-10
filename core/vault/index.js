// @ts-check
// vault — the module: credentials sealed at rest, released one item at a time to a module that
// holds a grant, shared with other people's Vyre by pass (docs/SPEC.md section 7.5).
//
// This file is the tool layer. It decides who may call what (ADR 0001, decision 6) and hands the
// work to the Vault class. The rule of thumb behind the table: giving access needs a person,
// taking it away never does, and no value ever travels through Claude. So `vault.put` refuses
// the mcp caller, an agent's grants and passes wait as pending, and `vault.release` is internal.
//
// The relay listener, when `vault.relay` is set in config.json, is the one door other people's
// Vyre come through. It serves a single route and only answers signed requests for live passes.

import { closeToAddedModules } from "../../lib/first-party-door.js";
import { core as coreHolder } from "../presence/index.js";
import { startForwarder } from "./forward.js";
import { modelMayRead } from "./api-request.js";
import { Vault, MIGRATIONS, KINDS, parseExpiry, ensureMacColumns, LAUNCHER_ITEMS, launcherItem, validModuleName } from "./vault.js";
import { DETAILS, defaultField } from "../../lib/vault-kinds/kinds.js";
import { codes, importCodes } from "./codes.js";
import { sweep } from "./sweep.js";
import { scheduleReminders, remindRun } from "./remind.js";
import * as rotateTools from "./tools/rotate.js";
import fs from "node:fs";
import path from "node:path";
import { serve, decodeTicket } from "./relay.js";
import { Fill, FILL_TOOLS, serveFill } from "./fill.js";
import { backup, restore, inspect } from "./backup.js";
import { envName } from "./cli-io.js";
import { callerKind } from "../modules/index.js";
import { isAsker } from "./asker.js";
import { presence, quoted, list } from "./tools/presence.js";
import * as account from "./tools/account.js";
import * as historyTools from "./tools/history.js";
import * as agentTools from "./tools/agents.js";
import { Access } from "./access.js";
import * as needsTools from "./tools/needs.js";
import * as connectionTools from "./tools/connections.js";
import { isDeviceGroupId } from "./devices.js";
import * as saidTools from "./said.js";
import * as agentFillTools from "./tools/agent-fill.js";
import { grantPrompt, putPrompt } from "./prompt.js";
import { scanEnvFiles } from "./envscan.js";
import * as requestTools from "./request.js";

export { presence };
import * as shareTools from "./tools/share.js";
import * as mcpTools from "./tools/mcp.js";
import { PassMcp } from "./passmcp.js";
import { listenMcp } from "./passmcp-listener.js";
import * as vaultsTools from "./tools/vaults.js";
import { register as registerCli } from "./tools/cli.js";
import { register as registerSurfaces } from "./tools/surfaces.js";
import * as linkTools from "./tools/links.js";
import { UsedBy } from "./used-by.js";
import * as deckTools from "./tools/deck.js";
import { reprompt } from "./session.js";
import { httpFetch } from "../../lib/http.js";

const PEOPLE = ["cli", "local"];
// The Deck and the Capsule are surfaces a person uses. They call as themselves, and the presence
// floor (ADR 0004) is what proves a person is there, whichever surface asks.
const SURFACES = [...PEOPLE, "deck", "capsule"];
// The phone app adds and unlocks from the app itself (UX-33): the paired phone calls as `mobile` (or its device label), and the presence floor, a Face ID on the phone, is what proves the person is there.
const PHONE = ["mobile", "device"];
const str = { type: "string" };
const strs = { type: "array", items: { type: "string" } };
const obj = (properties, required = []) => ({ type: "object", properties, required });
// The credentials port (the session launcher's way to a provider sign-in token). Not a tool: a frozen function the vault hands to the registry ONCE, at its own start, through
// `ctx.provide` (the registry refuses a second provider, and any module but the vault). The daemon and the launcher modules receive it from the registry's own dependencies, so no
// module and no daemon import reaches into the vault for it, and nothing that imports this file can take it.
/** @param {any} vault */
const credentialsPort = vault => Object.freeze({
  /** The sign-in token for a provider item: `claude` is the setup token (claude-setup-token), `anthropic` the API key (anthropic-api-key). The token, or null for nothing or an unknown name. The string shape sessions reads. @param {string} provider @returns {Promise<string | null>} */
  credentials: async provider => (Object.hasOwn(LAUNCHER_ITEMS, String(provider)) ? vault.providerToken(provider) : null),
  /** The key of an API-key account's vault item, for the lent computer's credential route (the home's kernel asks per request). Null for anything that is not an API-key item. @param {string} name */
  apiKey: async name => vault.apiKeyValue(name),
});

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    // A first-party tool declared anyone is open to an added module that lists it in needs.tools (ADR 0047). These four
    // take or use secrets for Vyre's own modules only: an added module reaches a secret through ctx.vault.fetch.
    closeToAddedModules(ctx, { only: ["vault.put", "vault.delete", "vault.totp", "vault.relay", "vault.request", "vault.verify", "vault.pending"] });
    // On a Mac with vyre-core, core holds the vault: forward, and never open the old store.
    if (coreHolder.link && typeof coreHolder.link.call === "function") return startForwarder(ctx, /** @type {any} */ (coreHolder.link));
    ctx.store.migrate(MIGRATIONS);
    ensureMacColumns(ctx.store.db);
    const vault = new Vault({ db: ctx.store.db, dir: ctx.paths.vault, config: ctx.config, emit: (t, p) => ctx.events.emit(t, p), log: ctx.log });
    // Who may use a login is a kernel grant (access.js); the vault keeps no table of it.
    vault.access = new Access(vault, ctx);
    /** @type {any} */ (vault).usedBy = new UsedBy(vault, ctx);
    // Every tool that returns or moves a value is held at the registry's floor, which asks the one yes (lib/one-yes.js) before the tool runs; nothing here asks twice.

    const opts = (ctx.config && ctx.config.vault) || {};
    // An existing home opens its agent vault now, so a v1 home is re-sealed as v2 at start
    // (ADR 0006, migration). A fresh home still makes its key on first use.
    if (!vault.guarded) {
      try { if (await vault.keys.exists()) await vault.key(); }
      catch (e) { ctx.log(`vault: not opened at start: ${/** @type {Error} */ (e).message}`); }
    }
    // Agent logins the vault stored itself before the one grant model become kernel grants (once; a locked vault does it at the next call).
    // The older credential scopes become grants once (agents start after the vault: until they answer it is tried again at the first model call).
    if (vault.access) vault.access.convertScopes(true).catch(e => ctx.log(`vault: credential scopes were not converted yet: ${/** @type {Error} */ (e).message}`));
    if (vault.access) vault.access.carry().catch(e => ctx.log(`vault: agent logins were not carried over yet: ${/** @type {Error} */ (e).message}`));
    if (typeof ctx.provide === "function") ctx.provide("credentialsPort", credentialsPort(vault));
    let listener = null;
    if (opts.relay && (opts.relay.port !== undefined || opts.relay.host)) {
      // The caller's identity on this listener is whatever the request carries and the pass binds to (the holder's device key). The old modes that took a login from a
      // VPN's `whois` answer or a proxy header are retired with that VPN (removal plan, step 4): a pass binds to the device key and the signed envelope.
      if (vault.relayGrants === "require") ctx.log("vault: vault.relay.grants is require, which needs a network policy that no longer exists, so every relayed request is refused; switch it off");
      listener = await serve({ host: opts.relay.host || "127.0.0.1", port: Number(opts.relay.port || 0), identity: vault.relayIdentity,
        onRelay: async (env, meta) => {
          return vault.onRelay(env, meta);
        },
        onSync: env => (isDeviceGroupId(env && env.vault) ? vault.devices.onSync(env) : vault.shared.onSync(env)),
        onEmergency: env => vault.emergency.onRequest(env) });
      vault.relayUrl = opts.relay.url ? String(opts.relay.url) : listener.url;
      ctx.log(`vault relay listening on ${listener.url}`);
    }

    // Autofill: a listener only browser extensions (and the Capsule's helper) talk to, after
    // pairing and unlock. vault.fill is a route there, never a registry tool, so no agent has it.
    const fill = new Fill({ vault, verifyVaultPassphrase: p => vault.checkPassphrase(p), config: ctx.config,
      extensions: opts.fill && Array.isArray(opts.fill.extensions) ? opts.fill.extensions.map(String) : [] });
    let fillListener = null;
    if (opts.fill && (opts.fill.port !== undefined || opts.fill.host)) {
      fillListener = await serveFill({ host: opts.fill.host || "127.0.0.1", port: Number(opts.fill.port || 0), fill, names: Array.isArray(opts.fill.names) ? opts.fill.names.map(String) : [] });
      ctx.log(`vault fill listening on ${fillListener.url}`);
    }

    /** `needs` is the tool's presence declaration; left out, the tool needs no person. */
    const tool = (name, callers, description, input, run, needs) => ctx.tool(name, { description, input, callers, run, ...(needs ? { presence: needs } : {}) });

    // A terminal's Touch ID window (core/presence TERMINAL_WINDOWED) proved this call, not a touch:
    // the audit says so, with the terminal, beside the line vyred wrote there.
    const windowUse = (how, action, name, caller) => {
      if (how && how.method === "window") vault.audit(action, name ?? null, caller, true, `Touch ID window on ${how.where || "a terminal"}`);
    };

    // item, resolve, render, edit, the git helper and the ssh agent (tools/cli.js).
    const cli = await registerCli({ ctx, vault });

    // The pairing code comes with the address the extension must use, so a person has both.
    for (const t of FILL_TOOLS) tool(t.name, t.callers, t.description, t.input, async (input, { caller }) => {
      const r = await fill[t.method](input, caller);
      return t.method === "code" ? { ...r, fill: fillListener ? fillListener.url : null } : r;
    }, t.presence ? presence(t.name, input => /** @type {any} */ (t.presence)(fill, input)) : undefined);

    // Backups are sealed to their own passphrase, so they are safe in any cloud drive. The
    // passphrase is a secret, so only people (cli, local) may call these.
    tool("vault.backup", PEOPLE, "Write a backup of the whole vault, sealed to a passphrase of its own.",
      obj({ file: str, passphrase: str }, ["file", "passphrase"]), async ({ file, passphrase }, { caller }) => {
        const p = path.resolve(file);
        const blob = await backup(vault, passphrase);
        fs.writeFileSync(p + ".tmp", blob + "\n", { mode: 0o600 });
        fs.renameSync(p + ".tmp", p);
        const info = inspect(blob);
        vault.audit("backup", null, caller, true, `${info.items} items to ${path.basename(p)}`);
        return { file: p, items: info.items, at: info.at };
      }, presence("Write a sealed backup of the vault", ({ file }) => {
        const n = Number(/** @type {any} */ (ctx.store.db.prepare("SELECT COUNT(*) AS n FROM vault_items").get()).n);
        return `Write a sealed backup of ${n} items to ${path.resolve(String(file))}`;
      }));

    tool("vault.restore", PEOPLE, "Restore a backup. merge adds what is missing; replace needs an empty vault.",
      obj({ file: str, passphrase: str, mode: { type: "string", enum: ["merge", "replace"] } }, ["file", "passphrase"]),
      ({ file, passphrase, mode }, { caller }) => restore(vault, fs.readFileSync(path.resolve(file), "utf8").trim(), passphrase, { mode, who: caller }),
      presence("Restore a vault backup", ({ file, mode }) => `Restore the backup ${path.resolve(String(file))} into this vault (${mode === "replace" ? "replace" : "merge"})`));

    // Modules may put too (onboarding stores the Claude credential this way), but only new items
    // or items they made themselves, and they may grant only what they put: neither reveals a
    // value the module did not already have. `value` is shorthand for fields.value.
    tool("vault.put", [...SURFACES, ...PHONE, "module"], "Add or replace an item. Values come from `vyre vault put`'s hidden prompt or a module, never from Claude.",
      obj({ name: str, kind: { type: "string", enum: KINDS }, description: str, value: str, fields: { type: "object" }, url: str, hosts: strs, apps: strs, reprompt: { type: "boolean" }, grants: strs, relay: obj({ body: { type: "boolean" } }), details: DETAILS }, ["name"]),
      async ({ value, grants, relay: relayRules, ...input }, { caller }) => {
        // `value` is the kind's own field: a PAT's token, a secret's value.
        if (value !== undefined) input.fields = { ...(input.fields || {}), [defaultField(input.kind || "secret") || "value"]: value };
        if (!input.fields) throw new Error("give the item a value or fields");
        const mod = caller.startsWith("module:") ? caller.slice(7) : null;
        if (!mod && grants) throw new Error("grants on put are for modules; people use vault.grant");
        // Every grant is checked BEFORE the item is written: a refused grant must not leave a changed value behind (reviewer-2 VP-5).
        if (grants !== undefined && (!Array.isArray(grants) || grants.length > 32)) throw new Error("grants is a short list of module names");
        const refuse = msg => { vault.refuse("put", input.name, caller, msg); throw new Error(msg); };
        for (const g of grants || []) if (!validModuleName(g)) refuse(`"${String(g).slice(0, 60)}" is not a module name`);
        // A provider sign-in token takes no module grant once the launcher reads it through the credentials port: refuse before anything is written, never after.
        if (grants && launcherItem(String(input.name)) && vault.launcherOnly) refuse(`${input.name} is a provider sign-in token; no module is granted it, the session launcher is handed it by the box itself`);
        // `<vault>/<item>` goes into a shared vault (shared.js); modules put only their own items.
        const slash = String(input.name).indexOf("/");
        if (slash > 0) {
          if (mod) throw new Error("modules cannot write to shared vaults");
          if (launcherItem(String(input.name).slice(slash + 1))) { const why = `${String(input.name).slice(slash + 1)} is a provider sign-in token; it is never put in a shared vault`; vault.refuse("put", input.name, caller, why); throw new Error(why); }
          if (input.kind === "api-credential") throw new Error("an api-credential is never put in a shared vault; it is used only by this Vyre's vault.request");
          return vault.shared.put({ ...input, vault: String(input.name).slice(0, slash), name: String(input.name).slice(slash + 1) }, caller);
        }
        if (mod) {
          const old = vault.row(input.name);
          if (old && old.origin !== caller) throw new Error(`${input.name} was not made by ${mod}, so ${mod} cannot replace it`);
          input.origin = caller;
        }
        const out = await vault.put({ ...input, ...(relayRules ? { relay: relayRules } : {}) }, caller);
        for (const g of grants || []) await vault.grant({ name: input.name, module: g }, caller);
        return { ...out, ...(grants ? { granted: grants } : {}) };
      }, presence("Save an item in the vault", ({ name, kind }) => {
        const old = vault.row(name);
        return putPrompt({ name, kind: kind || (old && old.kind) || "secret", replacing: Boolean(old) });
      }));

    tool("vault.list", null, "Every item's name, kind, description, field names, hosts and grants. Never a value.",
      obj({ filter: str, kind: str, host: str }), async (input, { caller, project, agent, agentKind }) => {
        const r = cli.list(vault.list(input), input);
        // A model (a named agent or the assistant) sees only the credentials it holds a grant for, by the same check a call makes, and only their names and kinds (reviewer-2 L-V3; the one grant model).
        const model = /^mcp(:|$)/.test(String(caller));
        if (!model || !r || !Array.isArray(r.items)) return r;
        if (vault.access && vault.access.K) {
          const mine = await vault.access.listFor(vault.access.modelName({ agent }, String(caller)));
          return { ...r, items: mine };
        }
        // SHIM(no kernel): the older rule, an agent sees what is granted to its project.
        const who = /^mcp:agent:(.+)$/.exec(String(caller));
        if (!who) return r;
        // The person's own assistant keeps its reach through vault.request (api-request: the assistant is not asked for a scope), so it is shown the credentials it can call: the name, kind,
        // description and hosts of each api-credential, never a value and never another kind of item. Without this it reads an empty vault and gives up on a credential it may use.
        const mine = g => Boolean(project) && g.project === project;
        // An api-credential is listed exactly when vault.request would let this caller read through it (modelMayRead: the one check), never more.
        return await (async () => {
          const callable = [];
          for (const i of r.items.filter(x => x.kind === "api-credential")) {
            let config; try { config = (await vault.apiCredential(i.name)).config; } catch { continue; }
            if (modelMayRead(config, { agent: who[1], project, agentKind })) callable.push({ name: i.name, kind: i.kind, ...(i.description ? { description: i.description } : {}), ...(i.hosts ? { hosts: i.hosts } : {}) });
          }
          const granted = r.items.filter(i => i.kind !== "api-credential" && (i.grants || []).some(mine)).map(i => ({ name: i.name, kind: i.kind }));
          return { ...r, items: [...callable, ...granted] };
        })();
      });

    // A provider's sign-in token (`claude setup-token`, or an Anthropic key) lives in the items core/onboard already makes (claude-setup-token, anthropic-api-key; LAUNCHER_ITEMS).
    // The person sets, replaces or removes one here with presence; the app learns only that one is stored and when. Nothing returns the value: the session launcher gets it through the
    // credentials port above and sets it in the session's own process.
    const provider = p => { const spec = Object.hasOwn(LAUNCHER_ITEMS, String(p)) ? LAUNCHER_ITEMS[String(p)] : null; if (!spec) throw new Error(`provider is one of ${Object.keys(LAUNCHER_ITEMS).join(", ")}`); return spec; };
    tool("vault.provider.set", SURFACES, "Store or replace a provider's session sign-in token (for Claude, the one `claude setup-token` makes). Sealed, yours, never shown again; the session launcher is the only thing that receives it.",
      obj({ provider: str, token: str }, ["provider", "token"]),
      async ({ provider: p, token }, { caller }) => {
        const spec = provider(p); if (/[\r\n\0\s]/.test(String(token))) throw new Error("a sign-in token is one line with no spaces");
        await vault.put({ name: spec.item, kind: spec.kind, description: `${p} sign-in token`, fields: { value: String(token) } }, caller);
        return { provider: p, stored: true };
      },
      presence("Store a provider sign-in token", ({ provider: p }) => `Store a ${String(p).slice(0, 32)} sign-in token in your vault`));
    tool("vault.provider.remove", SURFACES, "Remove a stored provider sign-in token.", obj({ provider: str }, ["provider"]),
      async ({ provider: p }, { caller }) => { vault.remove({ name: provider(p).item }, caller); return { provider: p, stored: false }; },
      presence("Remove a provider sign-in token", ({ provider: p }) => `Remove the ${String(p).slice(0, 32)} sign-in token from your vault`));
    tool("vault.provider.status", SURFACES, "Which provider sign-in tokens are stored and when each was added. Never the value.", obj({ provider: str }),
      async ({ provider: p } = {}) => ({ tokens: vault.providerTokens().filter(t => !p || t.provider === p) }));

    tool("vault.delete", [...SURFACES, "module"], "Delete an item and its grants. A first-party module may delete only an item it made itself (its own origin).",
      obj({ name: str }, ["name"]), (input, { caller }) => {
        // A module has no presence proof to give: the person's own action (a person-only tool of that module) is the proof. Origin is set by
        // vyred when the module puts the item and cannot be passed in, so a module can delete only what it made, never a person's or another's.
        if (String(caller).startsWith("module:")) {
          const mod = String(caller).slice(7), own = vault.row(input.name);
          if (!own) throw new Error(`no item named ${input.name}`);
          if (own.origin !== caller) throw new Error(`${input.name} was not made by ${mod}, so ${mod} cannot delete it`);
        }
        // `<vault>/<item>` in a shared vault goes as a signed tombstone (shared.js).
        const r = vault.row(input.name);
        const slash = String(input.name).indexOf("/");
        if (r && String(r.vault).startsWith("shared:") && slash > 0) return vault.shared.deleteItem({ vault: String(input.name).slice(0, slash), name: String(input.name).slice(slash + 1) }, caller);
        return vault.remove(input, caller);
      },
      presence("Delete an item from the vault", ({ name }) => `Delete ${quoted(name)} and its grants`, { when: ({ name }) => { const r = vault.row(name); return Boolean(r && r.vault !== "personal"); } }));

    tool("vault.grant", [...SURFACES, "mcp"], "Let a module (or one watcher) use an item through ctx.vault.fetch. From Claude it waits for a person to approve it.",
      obj({ name: str, module: str, watcher: str, project: { type: "string", description: "scope the grant to this project; omit for every project" } }, ["name", "module"]), (input, { caller, presence: how }) => { windowUse(how, "grant", input.name, caller); return vault.grant(input, caller); },
      // From Claude a grant only waits as pending, and approving it needs a person, so the proof is skipped there.
      presence("Let a module use a vault item", ({ name, module, watcher, project }) => `Let ${module}${watcher ? `/${watcher}` : ""} use ${quoted(name)}${project ? ` in ${project}` : ""} while you are away${vault.row(name)?.vault === "personal" ? "; this moves it out of your password-protected vault" : ""}`,
        { skip: ({ caller }) => isAsker(caller), session: () => true }));

    tool("vault.revoke", ["cli", "local", "deck", "capsule", "tailnet", "device", "module", "mcp"], "Take an item away from a module, or from one of its watchers, in one project or (with no project) every one.",
      obj({ name: str, module: str, watcher: str, project: str }, ["name", "module"]), (input, { caller }) => {
        const c = String(caller);
        const k = callerKind(c);
        // The person's surfaces revoke any grant. A model session (named agent, thread or bare mcp) and another module may only withdraw a request they made themselves (group D LOW).
        return vault.revoke(input, c, k === "mcp" || k === "harness" || k === "module" ? { onlyPendingBy: c } : {});
      });

    // "module": the approvals queue lists what waits as cards (core/approvals/items.js); names only, and only Vyre's own modules (closeToAddedModules above).
    tool("vault.pending", [...SURFACES, "mcp", "module"], "Grants and passes an agent asked for, waiting for a person.",
      obj({}), () => vault.pending());

    tool("vault.approve", SURFACES, "Approve a pending grant or pass.",
      obj({ id: str }, ["id"]), (input, meta) => { windowUse(meta.presence, "approve", input.id, meta.caller); return vault.approve(input, meta.caller, meta); },
      presence("Approve a pending grant or pass", ({ id }) => {
        const p = vault.pending();
        const g = p.grants.find(x => x.id === id);
        if (g) return grantPrompt(g, vault.row(g.name)?.vault === "personal");
        const ag = p.agentGrants.find(x => x.id === id);
        if (ag) return vault.agents.summary(ag, () => ag.expires);
        const s = p.passes.find(x => x.id === id);
        if (s) return `Share ${list(s.items)} with ${s.holder}, ${s.mode}, until ${new Date(s.expires).toISOString().slice(0, 10)}`;
        return "";
      // A presence session from the Deck or the Capsule covers approving (the floor keeps the CLI out).
      }, { session: () => true }));

    // The answer to "is this item granted to the calling module (and this watcher)?", from the very check `release` makes; it hands over no value. For a module that reads through something the vault
    // does not hold the token of (a Google account), so the person's per-watcher grant is the one permission, not a second copy of it.
    ctx.tool("vault.granted", {
      internal: true,
      description: "Whether an item is granted to the calling module, and to exactly this watcher when one is named: { granted }. The same check vault.release makes; no value is returned.",
      input: obj({ name: str, watcher: str, project: str }, ["name"]),
      run: (input, { caller }) => { const mod = String(caller).startsWith("module:") ? String(caller).slice(7) : null; if (!mod) throw new Error("only modules ask whether they hold a grant"); return { granted: vault.granted({ name: input.name, module: mod, ...(input.watcher ? { watcher: input.watcher } : {}), ...(input.project ? { project: input.project } : {}) }) }; },
    });

    ctx.tool("vault.release", {
      internal: true,
      description: "One value, to a module holding a grant for it, or to Publish for a deployment holding its own grant. `project`, when the grant names one, must match.",
      input: obj({ name: str, field: str, watcher: str, project: str, deployment: str }, ["name"]),
      run: (input, { caller }) => vault.release(input, caller),
    });

    tool("vault.inject", PEOPLE, "Values for `vyre vault run`, which puts them in one child process's environment.",
      obj({ items: { type: "array", items: obj({ name: str, env: str, field: str }, ["name"]) } }, ["items"]),
      (input, { caller }) => vault.inject(input, caller, envName),
      presence("Put vault items into a program's environment", ({ items }) =>
        `Put ${(Array.isArray(items) ? items : []).map(i => i && i.env ? `${quoted(i.name)} as ${i.env}` : quoted(i && i.name)).join(", ")} into a program's environment`));

    // A surface with a live session skips the proof for a non-reprompt item (ADR 0006, decision 3).
    tool("vault.totp", [...SURFACES, "module", "tailnet", "device"], "The current one-time code for a login with a TOTP seed.",
      // `id` is the Capsule's name for the item (its actions get `{ id, front }`).
      obj({ name: str, id: str, session: str }),
      async ({ name, id }, { caller }) => {
        const n = name ?? id;
        if (typeof n !== "string" || !n) throw new Error("name the item");
        const r = await vault.code({ name: n }, caller);
        return { code: r.code, next: r.next, period: r.period ?? 30, remaining: r.remaining };
      },
      presence("Show a one-time code", ({ name, id }) => `Show the one-time code for ${quoted(name ?? id)}`,
        { skip: ({ input }) => Boolean(input && /** @type {any} */ (vault).sessions?.ok(input.session, input.name ?? input.id)),
          // The presence floor's session method covers a code unless the item is reprompt.
          session: input => { const n = input && (input.name ?? input.id); return typeof n === "string" && !reprompt(vault, n); } }));

    // The leak sweep (ADR 0028): where the vault's values, and credentials it lacks, sit in plain text.
    tool("vault.sweep", ["cli", "local", "deck", "mcp"], "Search a folder, its git history and the shell history for values the vault holds and credentials it lacks. Returns places and names, never values.",
      obj({ path: str, history: { type: "boolean", description: "also search the folder's git history" }, shell: { type: "boolean", description: "also search the shell history" } }, ["path"]), (input, { caller }) => sweep(vault, input, caller),
      presence("Look for leaked secrets", ({ path: p, history, shell }) => `Compare every value in the vault with the files in ${path.resolve(String(p))}${history ? ", its git history" : ""}${shell ? " and your shell history" : ""}`));

    // The authenticator (ADR 0028): every code at once, current and next, on the same window as one.
    tool("vault.codes", SURFACES, "Every one-time code: the current and next code for each item with a TOTP seed, the seconds left, and the issuer. Never a seed.",
      obj({ names: strs, session: str }), (input, { caller }) => codes(vault, { names: input.names }, caller),
      presence("Show your one-time codes", () => "Show the current one-time codes for every account in the vault",
        { session: () => true }));

    // Scanned codes only: the person's own camera read them, so they never pass through Claude.
    tool("vault.codes.import", SURFACES, "Bring in accounts from scanned codes: every part of a Google Authenticator export (otpauth-migration://), or otpauth://totp/ addresses. preview stores nothing. A split export waits until every part is scanned.",
      obj({ uris: strs, preview: { type: "boolean" } }, ["uris"]), (input, { caller }) => importCodes(vault, input, caller),
      presence("Import one-time codes", ({ uris, preview }) => `${preview ? "Preview" : "Import"} ${Array.isArray(uris) ? uris.length : 0} scanned code${Array.isArray(uris) && uris.length === 1 ? "" : "s"} into the vault`));

    tool("vault.generate", ["cli", "local", "mcp"], "Generate a password or passphrase. With `name` it is stored and never returned; Claude must give a name.",
      obj({ length: { type: "integer" }, words: { type: "integer" }, symbols: { type: "boolean" }, name: str, description: str }),
      (input, { caller }) => {
        if (isAsker(caller) && !input.name) throw new Error("give a name: a generated password is stored, never shown to Claude");
        // Into an existing name is a put by another name (it replaces a login's password), so
        // Claude may only create (ADR 0006 finding 7).
        if (isAsker(caller) && vault.row(input.name)) throw new Error(`${input.name} already exists; Claude may only generate into a new name`);
        return vault.generate(input, caller);
      });

    // Preview opens the file and the existing logins, so it asks for the same presence as import
    // (ADR 0028, decision 1). It returns names and counts, never a value.
    // The app sends the bytes of the file the person picked (`content`, base64, with its `filename`); an assistant never does, so a value cannot pass through Claude.
    const noContentFromClaude = (input, caller) => { if (input.content !== undefined && isAsker(caller)) throw new Error("Claude reads a file by its path on this machine; the bytes are never passed through Claude"); };
    const what = ({ file, filename }) => (file ? path.resolve(String(file)) : String(filename || "the exported file"));
    tool("vault.import.preview", [...SURFACES, ...PHONE, "mcp"], "Preview an import by name and count only: what it adds, skips or finds in conflict, plus a token binding vault.import to this file.",
      obj({ file: { type: "string", description: "path to a file, or a folder scanned for .env files (variables come back with type and secret flag)" }, format: str, content: str, filename: str }), (input, { caller }) => { noContentFromClaude(input, caller); if (!input.file && input.content === undefined) throw new Error("give a file path, or the file's content"); return vault.importPreview(input, caller); },
      presence("Preview a file for import", input => `Preview the items in ${what(input)}`));

    // Several .env files in one call, so one yes covers a whole scan (vault.env.scan lists them). Each is imported on its own and the answers are merged; a file that fails is reported, and the rest still go.
    const importMany = async (input, caller) => {
      const files = input.files;
      if (!Array.isArray(files) || !files.length || files.length > 100 || !files.every(f => typeof f === "string" && path.isAbsolute(f))) throw new Error("files is a list of up to 100 absolute paths");
      const out = { format: "env", added: [], updated: [], same: [], conflicts: [], renamed: [], skipped: [], rewritten: [], unchanged: [], committed: [] };
      for (const file of files) {
        try {
          const r = await vault.import({ file, format: "env", conflicts: input.conflicts, rewrite: input.rewrite }, caller);
          for (const k of Object.keys(out)) if (Array.isArray(r[k])) out[k].push(...r[k]);
        } catch (e) { out.skipped.push(`${path.basename(path.dirname(file))}/${path.basename(file)}: ${e.message}`); out.unchanged.push(file); }
      }
      return out;
    };
    tool("vault.import", [...SURFACES, ...PHONE, "mcp"], "Import a .env file, a folder of them, or a password manager export. vyred reads the files; values never pass through Claude.",
      obj({ file: { type: "string", description: "path to a .env file, a folder of them, or an export from 1Password, Bitwarden, LastPass, Dashlane, Chrome, Apple Passwords and other managers" }, format: str, token: { type: "string", description: "the token from vault.import.preview; refuses a file that changed since" }, conflicts: { type: "string", enum: ["skip", "update"], description: "update makes a new version of the existing item" }, rewrite: { type: "boolean", description: "swap each imported .env value for a vault:// reference once stored" }, content: str, filename: str, files: { type: "array", items: { type: "string" }, description: "absolute paths of several .env files, imported under one yes" } }),
      (input, { caller }) => {
        noContentFromClaude(input, caller);
        if (input.files !== undefined) return importMany(input, caller);
        if (!input.file && input.content === undefined) throw new Error("give a file path, or the file's content");
        return vault.import(input, caller);
      },
      presence("Import a file into the vault", input => Array.isArray(input.files) ? `Import ${input.files.length} .env file${input.files.length === 1 ? "" : "s"} into the vault${input.rewrite ? " and rewrite them to vault references" : ""}` : `Import the items in ${what(input)} into the vault${input.rewrite ? " and rewrite its .env files to vault references" : ""}`));

    tool("vault.env.scan", [...SURFACES, ...PHONE], "The .env files in your project folders that hold secrets: which project, how many secrets, what kinds, whether git tracks the file, and the command that imports it. Names and counts only, never a value. Import each with vault.import and rewrite, which swaps the values for vault references.",
      obj({ roots: strs }), async ({ roots }) => {
        /** @type {{ project?: string, dir: string }[]} */
        let dirs = [];
        if (Array.isArray(roots) && roots.length) dirs = roots.filter(r => typeof r === "string" && path.isAbsolute(r)).map(dir => ({ dir }));
        else {
          const r = await ctx.call("projects.list", {}).catch(() => null);
          for (const p of (r && r.data && Array.isArray(r.data.projects) ? r.data.projects : [])) {
            for (const d of [p.home, ...(Array.isArray(p.folders) ? p.folders : [])]) if (typeof d === "string" && d) dirs.push({ project: String(p.name || p.slug || ""), dir: d });
          }
        }
        return scanEnvFiles(dirs);
      });

    tool("vault.audit", ["cli", "local", "deck", "capsule", "tailnet", "device", "module"], "Who used which item, when, and whether it was allowed. Never a value.",
      obj({ name: str, limit: { type: "integer" } }), input => vault.auditTrail(input));

    tool("vault.match", SURFACES, "Logins for a page, for autofill: names only.",
      obj({ url: str }, ["url"]), input => vault.match(input));

    tool("vault.state", [...SURFACES, ...PHONE], "Whether the vault is open, for the app's empty and locked states: { locked, keystore, unlock: \"passphrase\" | \"none\", items }. Never a value.",
      obj({}), async () => { const locked = await vault.locked(); return { locked, keystore: vault.kind, unlock: vault.kind === "passphrase" ? "passphrase" : "none", items: locked ? null : (l => (Array.isArray(l) ? l : l.items || []).length)(vault.list({})) }; });

    tool("vault.unlock", [...PEOPLE, ...PHONE], "Unlock a passphrase vault (the first unlock sets the passphrase).",
      obj({ passphrase: str }, ["passphrase"]), input => vault.unlock(input.passphrase),
      presence("Unlock the vault", () => "Unlock the vault"));

    tool("vault.lock", null, "Forget the key until the next unlock.", obj({}), () => vault.lock());

    tool("vault.identity", null, "This Vyre's public card, to give to someone who will share items with you. It holds no secret.",
      obj({}), () => vault.card());

    tool("vault.pass.create", [...SURFACES, "mcp"], "Share items with another person's Vyre. Relayed by default: the value never leaves this box. From Claude it waits for approval.",
      obj({ holder: str, card: str, items: strs, mode: { type: "string", enum: ["relayed", "sealed"] }, hosts: strs, methods: strs, paths: strs, expires: str, note: str }, ["holder", "items"]),
      (input, { caller }) => vault.createPass(input, caller),
      presence("Share vault items with someone", ({ holder, items, mode, expires }) => {
        let until = "";
        try { until = `, until ${new Date(parseExpiry(expires)).toISOString().slice(0, 10)}`; } catch {}
        return `Share ${list(items)} with ${String(holder).slice(0, 64)}, ${mode === "sealed" ? "sealed (a copy leaves this Vyre)" : "relayed"}${until}`;
      }, { skip: ({ caller }) => isAsker(caller) }));

    // Reveals no value, only logins, item names and what the policy says, so no presence. Owner
    // callers only: an agent caller has no business mapping who can reach what.
    tool("vault.grants.status", [...SURFACES, "mcp"], "Whether each pass holder is covered for what they hold, as last seen at the relay. Reads names and logins only, never a value.",
      obj({}), async (_input, { caller }) => {
        if (/(?:^|[\s:])agent:/.test(String(caller))) throw new Error("vault.grants.status is for the owner, not an agent");
        return vault.grantsStatus();
      });

    tool("vault.pass.list", ["cli", "local", "deck", "capsule", "tailnet", "device", "module"], "Passes this Vyre gave, and passes it holds.", obj({}), () => vault.passes());

    tool("vault.pass.revoke", null, "End a pass. A relayed pass stops at once; a sealed one lists what to rotate.",
      obj({ id: str }, ["id"]), (input, { caller }) => vault.revokePass(input, caller));

    tool("vault.pass.accept", [...SURFACES, "mcp"], "Take a signed pass ticket someone sent you. From Claude it waits for a person to approve it.",
      obj({ ticket: str }, ["ticket"]), (input, { caller }) => vault.accept(input, caller),
      presence("Accept a pass someone sent", ({ ticket }) => {
        const t = decodeTicket(ticket);
        return `Accept a ${t.mode} pass from ${t.owner} holding ${list(t.items)}`;
      }, { skip: ({ caller }) => isAsker(caller) }));

    tool("vault.relay", ["cli", "local", "module"], "Use an item someone relayed to you: put {{vault}} (or {{vault.<field>}}) in a header or the body, and their Vyre adds the value.",
      obj({ item: str, owner: str, request: obj({ method: str, url: str, headers: { type: "object" }, body: str }, ["url"]) }, ["item", "request"]),
      (input, { caller }) => vault.relayOut(input, caller));

    // Emergency access (ADR 0028, decision 8). Adding and refreshing open every item, and the
    // contact's status call may take them in, so those need a person; deny and remove never do.
    if (ctx.call) vault.emergency.call = (name, input) => ctx.call(name, input);
    const who = p => String(p ?? "").slice(0, 64);
    tool("vault.emergency.add", SURFACES, "Keep emergency access for a verified contact: they can ask, and after the wait (7d by default, 1d to 30d) the items open to them unless you deny it. Every item except ssh keys and passkeys unless `items` names some.",
      obj({ person: str, wait: str, items: strs }, ["person"]), (input, { caller }) => vault.emergency.add(input, caller),
      presence("Keep emergency access for someone", ({ person, wait, items }) => who(person) && `Let ${who(person)} open ${Array.isArray(items) && items.length ? list(items) : "every item except ssh keys and passkeys"} ${String(wait || "7d").slice(0, 8)} after they ask, unless you deny it`));
    tool("vault.emergency.refresh", SURFACES, "Rebuild the escrowed emergency ticket for one contact or all, so items added since are in it. It happens on its own at most once a day when the personal vault is unlocked.",
      obj({ person: str }), (input, { caller }) => vault.emergency.refresh(input, caller),
      presence("Rebuild emergency access", ({ person }) => `Seal every emergency item again for ${who(person) || "each emergency contact"}`));
    tool("vault.emergency.deny", null, "Close an emergency request (or a release) from a contact. They may ask again, and wait again.",
      obj({ person: str }, ["person"]), (input, { caller }) => vault.emergency.deny(input, caller));
    tool("vault.emergency.remove", null, "End a contact's emergency access and delete its escrow.",
      obj({ person: str }, ["person"]), (input, { caller }) => vault.emergency.remove(input, caller));
    tool("vault.emergency.list", ["cli", "local", "deck", "capsule", "tailnet", "device", "module"], "Emergency contacts: the wait, where a request stands and when it opens. Names only.",
      obj({}), () => vault.emergency.list());
    tool("vault.emergency.request", SURFACES, "Ask an owner who named you as an emergency contact for access. It opens after their wait unless they deny it.",
      obj({ owner: str }, ["owner"]), (input, { caller }) => vault.emergency.request(input, caller),
      presence("Ask for emergency access", ({ owner }) => who(owner) && `Ask ${who(owner)} for emergency access to their vault`));
    tool("vault.emergency.status", SURFACES, "Where an emergency request to an owner stands; once it has opened, the items are taken into this vault.",
      obj({ owner: str }, ["owner"]), (input, { caller }) => vault.emergency.status(input, caller),
      presence("Check emergency access", ({ owner }) => who(owner) && `Check emergency access with ${who(owner)}, and take their items in if it has opened`));

    account.register({ ctx, vault, tool });
    historyTools.register({ ctx, vault, tool });
    agentTools.register({ vault, tool });
    // What modules need from the Vault, and the one way to fill it (ADR 0028, decision 9a).
    needsTools.register({ ctx, vault, tool });
    // Every connection and which surface may use it (ADR 0028, decision 9b).
    const conns = connectionTools.register({ ctx, vault, tool });
    // Google and mcp start after the vault, so their rows sync on first read and on their events.
    if (!vault.guarded) conns.connections.resync(["vault"]).catch(() => {});

    // What the person's own turns asked to go out (P17): stored here, matched by the Gate.
    /** A tool only other modules can call, as vault.release is. */
    const internal = (name, description, input, run) => ctx.tool(name, { internal: true, description, input, run });
    const said = saidTools.register({ vault, internal, tool, emit: (t, p) => ctx.events.emit(t, p) });
    // vault.agent.fill signs an agent in on its own computer; vault.tagged / vault.untag show and end what a # tag has lent. A # tag ends with its conversation.
    agentFillTools.register({ ctx, vault, said, tool });
    try { ctx.events.on("thread.deleted", (/** @type {any} */ e) => { const t = String((e && e.payload && (e.payload.thread || e.payload.uuid || e.payload.id)) || (e && e.thread) || ""); if (t) said.dropThread(t, "module:vault"); }); } catch { /* no event bus in a bare test */ }
    // A vendor API call with an api-credential: reads run, asked-for sends run, the rest hold at the Gate.
    const requests = requestTools.register({ vault, tool, internal, said, call: ctx.call ? (name, input) => ctx.call(name, input) : undefined, log: ctx.log });

    tool("vault.offboard", [...SURFACES, "mcp"], "Someone left: revoke every pass they hold and list what must be rotated.",
      obj({ person: str }, ["person"]), (input, { caller }) => vault.offboard(input, caller),
      presence("Offboard someone", ({ person }) => `Revoke every pass ${String(person).slice(0, 64)} holds and forget their card`));

    // The Vault MCP for outside agents (passmcp.js): the endpoint is off unless `vault.mcp.port` is set; passes can be made and listed either way.
    let mcpListener = null;
    vault.mcp = new PassMcp(vault, { requests, log: ctx.log, url: () => (opts.mcp && opts.mcp.url ? String(opts.mcp.url) : mcpListener ? mcpListener.url : "") });
    mcpTools.register({ vault, tool, internal });
    if (opts.mcp && (opts.mcp.port !== undefined || opts.mcp.host)) {
      mcpListener = await listenMcp({ host: opts.mcp.host || "127.0.0.1", port: Number(opts.mcp.port || 0), handle: q => vault.mcp.handle(q) });
      vault.mcp.listener = mcpListener;
      ctx.log(`vault mcp listening on ${mcpListener.url}`);
    }
    const kits = shareTools.register({ ctx, vault, tool });
    vaultsTools.register({ vault, tool });
    linkTools.register({ vault, tool });
    // Pull from homes on start, after each local write, on a poke, and every ten minutes at most.
    if (!vault.guarded) vault.devices.start();

    const surfaces = registerSurfaces({ ctx, vault });

    deckTools.register({ ctx, vault });

    // Watchtower's findings as planner todos, once a day after 09:00 (ADR 0028, decision 4).
    const call = (name, input) => (ctx.call ? ctx.call(name, input) : Promise.resolve({ error: { code: "no_such_tool", message: "no planner" } }));
    tool("vault.remind.run", ["cli", "local", "deck"], "Run the daily reminder pass now: new Watchtower findings become planner todos in the Vault list, fixed ones are marked done. Names only.",
      obj({}), async () => remindRun(vault, call));
    rotateTools.register({ vault, tool, presence, quoted, call, endpoints: opts.rotate_endpoints });
    const reminders = opts.reminders === false || !ctx.call ? { stop() {} }
      : scheduleReminders(vault, call, { log: ctx.log, local: !(ctx.config && ctx.config.role === "box"),
        // The same opt-in vault.breach.check asks presence for; a scheduled run has nobody to
        // ask, so config is the person's standing answer (ADR 0028).
        breach: { enabled: opts.breach === "ask", fetch: httpFetch },
        connections: conns.connections });

    return {
      ssh: cli.ssh,
      vault,
      connections: conns.connections,
      async stop() {
        if (typeof ctx.provide === "function") ctx.provide("credentialsPort", null); // a stopped vault has no port: the launcher sees none and says so, never a stale answer
        requests.stop();
        if (mcpListener) await mcpListener.close();
        reminders.stop();
        await conns.stop();
        await kits.stop();
        vault.devices.stop();
        await cli.stop();
        await vault.stop();
        await surfaces.stop();
        if (listener) await listener.close();
        if (fillListener) await fillListener.close();
      },
    };
  },
};
