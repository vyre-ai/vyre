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
import { Vault, MIGRATIONS, KINDS, parseExpiry, ensureMacColumns, LAUNCHER_ITEMS, launcherItem, validModuleName } from "./vault.js";
import { DETAILS, defaultField } from "../../lib/vault-kinds/kinds.js";
import { codes, importCodes } from "./codes.js";
import { sweep } from "./sweep.js";
import { scheduleReminders, remindRun } from "./remind.js";
import * as rotateTools from "./tools/rotate.js";
import fs from "node:fs";
import path from "node:path";
import { serve, decodeTicket } from "./relay.js";
import { whois, run as tailscale } from "../names/tailscale.js";
import { isTailnet, normalize } from "../names/identity.js";
import { Fill, FILL_TOOLS, serveFill } from "./fill.js";
import { backup, restore, inspect } from "./backup.js";
import { envName } from "./cli-io.js";
import { callerKind } from "../modules/index.js";
import { presence, quoted, list } from "./tools/presence.js";
import * as account from "./tools/account.js";
import * as historyTools from "./tools/history.js";
import * as agentTools from "./tools/agents.js";
import * as needsTools from "./tools/needs.js";
import * as connectionTools from "./tools/connections.js";
import { isDeviceGroupId } from "./devices.js";
import * as saidTools from "./said.js";
import { grantPrompt, putPrompt } from "./prompt.js";
import { scanEnvFiles } from "./envscan.js";
import * as requestTools from "./request.js";

export { presence };
import * as shareTools from "./tools/share.js";
import * as vaultsTools from "./tools/vaults.js";
import { register as registerCli } from "./tools/cli.js";
import { register as registerSurfaces } from "./tools/surfaces.js";
import * as deckTools from "./tools/deck.js";
import { gate } from "./prove.js";
import { reprompt } from "./session.js";

const PEOPLE = ["cli", "local"];
// The Deck and the Capsule are surfaces a person uses. They call as themselves, and the presence
// floor (ADR 0004) is what proves a person is there, whichever surface asks.
const SURFACES = [...PEOPLE, "deck", "capsule"];
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
});

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    // A first-party tool declared anyone is open to an added module that lists it in needs.tools (ADR 0047). These four
    // take or use secrets for Vyre's own modules only: an added module reaches a secret through ctx.vault.fetch.
    closeToAddedModules(ctx, { only: ["vault.put", "vault.delete", "vault.totp", "vault.relay", "vault.request", "vault.verify"] });
    // On a Mac with vyre-core, core holds the vault: forward, and never open the old store.
    if (coreHolder.link && typeof coreHolder.link.call === "function") return startForwarder(ctx, /** @type {any} */ (coreHolder.link));
    ctx.store.migrate(MIGRATIONS);
    ensureMacColumns(ctx.store.db);
    const vault = new Vault({ db: ctx.store.db, dir: ctx.paths.vault, config: ctx.config, emit: (t, p) => ctx.events.emit(t, p), log: ctx.log });
    // Every tool that returns or moves a value asks for presence first (prove.js), until the
    // registry does it (ADR 0004). All registrations below go through this ctx.
    const gated = gate({ ctx, vault });
    const base = ctx;
    ctx = Object.assign(Object.create(base), { tool: (name, def) => base.tool(name, gated(name, def)) });

    const opts = (ctx.config && ctx.config.vault) || {};
    // An existing home opens its agent vault now, so a v1 home is re-sealed as v2 at start
    // (ADR 0006, migration). A fresh home still makes its key on first use.
    if (!vault.guarded) {
      try { if (await vault.keys.exists()) await vault.key(); }
      catch (e) { ctx.log(`vault: not opened at start: ${/** @type {Error} */ (e).message}`); }
    }
    if (typeof ctx.provide === "function") ctx.provide("credentialsPort", credentialsPort(vault));
    let listener = null;
    if (opts.relay && (opts.relay.port !== undefined || opts.relay.host)) {
      // With identity "whois" no header counts: the login is the one Tailscale gives the peer
      // address, and meta.peer is the rest of that answer (node, stable id, tags, caps), which
      // vault.relay.grants "require" reads. A tagged node has no login, so it is never a holder.
      const byWhois = opts.relay.identity === "whois"
        ? async ip => { if (!isTailnet(ip)) return null; return whois(normalize(ip)); }
        : null;
      if (byWhois) vault.lookupPeer = peerByLogin;
      if (vault.relayGrants === "require" && vault.relayIdentity !== "whois") ctx.log("vault: vault.relay.grants is require but vault.relay.identity is not whois, so no caller carries caps and every relayed request is refused");
      listener = await serve({ host: opts.relay.host || "127.0.0.1", port: Number(opts.relay.port || 0), identity: vault.relayIdentity,
        onRelay: async (env, meta) => {
          if (!byWhois) return vault.onRelay(env, meta);
          return vault.onRelay(env, whoisMeta(meta, await byWhois(meta.remoteAddress)));
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
    tool("vault.put", [...SURFACES, "module"], "Add or replace an item. Values come from `vyre vault put`'s hidden prompt or a module, never from Claude.",
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
        if (grants && launcherItem(String(input.name)) && vault.launcherOnly) refuse(`${input.name} is a provider sign-in token; no module is granted it, the session launcher is handed it by vyred itself`);
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
      obj({ filter: str, kind: str, host: str }), (input, { caller, project }) => {
        const r = cli.list(vault.list(input), input);
        // A named agent sees only the items granted to it or to its project, and only their names and kinds (reviewer-2 L-V3).
        // Grants go to MODULES (and narrow to a project), never to an agent as such, and an agent's name is its own choice, so it is
        // never matched against a module name. "Granted to that agent" means one key: the agent's verified project scope (meta.project)
        // equals a grant's project. An agent with no project sees nothing.
        const who = /^mcp:agent:(.+)$/.exec(String(caller));
        if (!who || !r || !Array.isArray(r.items)) return r;
        const mine = g => Boolean(project) && g.project === project;
        return { ...r, items: r.items.filter(i => (i.grants || []).some(mine)).map(i => ({ name: i.name, kind: i.kind })) };
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
      presence("Delete an item from the vault", ({ name }) => `Delete ${quoted(name)} and its grants`));

    tool("vault.grant", [...SURFACES, "mcp"], "Let a module (or one watcher) use an item through ctx.vault.fetch. `project` scopes it to one project; omitted, it is good for every project. From Claude it waits for a person to approve it.",
      obj({ name: str, module: str, watcher: str, project: str }, ["name", "module"]), (input, { caller, presence: how }) => { windowUse(how, "grant", input.name, caller); return vault.grant(input, caller); },
      // From Claude a grant only waits as pending, and approving it needs a person, so the proof is skipped there.
      presence("Let a module use a vault item", ({ name, module, watcher, project }) => `Let ${module}${watcher ? `/${watcher}` : ""} use ${quoted(name)}${project ? ` in ${project}` : ""} while you are away${vault.row(name)?.vault === "personal" ? "; this moves it out of your password-protected vault" : ""}`,
        { skip: ({ caller }) => callerKind(caller) === "mcp", session: () => true }));

    tool("vault.revoke", null, "Take an item away from a module, or from one of its watchers, in one project or (with no project) every one.",
      obj({ name: str, module: str, watcher: str, project: str }, ["name", "module"]), (input, { caller }) => {
        const c = String(caller);
        // A named agent, or another module, may only withdraw a request it made itself; the person's surfaces and an unnamed session revoke freely.
        return vault.revoke(input, c, /^mcp:agent:/.test(c) || c.startsWith("module:") ? { onlyPendingBy: c } : {});
      });

    tool("vault.pending", [...SURFACES, "mcp"], "Grants and passes an agent asked for, waiting for a person.",
      obj({}), () => vault.pending());

    tool("vault.approve", SURFACES, "Approve a pending grant or pass.",
      obj({ id: str }, ["id"]), (input, { caller, presence: how }) => { windowUse(how, "approve", input.id, caller); return vault.approve(input, caller); },
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

    ctx.tool("vault.release", {
      internal: true,
      description: "One value, to a module holding a grant for it. `project`, when the grant names one, must match.",
      input: obj({ name: str, field: str, watcher: str, project: str }, ["name"]),
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
    tool("vault.sweep", ["cli", "local", "deck", "mcp"], "Look in a folder, its git history (history) and the shell's history (shell) for values the vault holds and for credentials it does not hold yet. Returns places and item names or credential types, never a value.",
      obj({ path: str, history: { type: "boolean" }, shell: { type: "boolean" } }, ["path"]), (input, { caller }) => sweep(vault, input, caller),
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
        if (callerKind(caller) === "mcp" && !input.name) throw new Error("give a name: a generated password is stored, never shown to Claude");
        // Into an existing name is a put by another name (it replaces a login's password), so
        // Claude may only create (ADR 0006 finding 7).
        if (callerKind(caller) === "mcp" && vault.row(input.name)) throw new Error(`${input.name} already exists; Claude may only generate into a new name`);
        return vault.generate(input, caller);
      });

    // Preview opens the file and the existing logins, so it asks for the same presence as import
    // (ADR 0028, decision 1). It returns names and counts, never a value.
    tool("vault.import.preview", ["cli", "local", "mcp"], "What an import would add, skip as already here, or find in conflict, by name and count only, with a token that binds vault.import to this exact file. A folder is scanned for .env files; each file's variables come back with their type and whether they are secret, never a value.",
      obj({ file: str, format: str }, ["file"]), (input, { caller }) => vault.importPreview(input, caller),
      presence("Preview a file for import", ({ file }) => `Preview the items in ${path.resolve(String(file))}`));

    tool("vault.import", ["cli", "local", "mcp"], "Import a .env file, a folder of them, or a 1Password, Bitwarden, Chrome or Apple Passwords export. vyred reads the files itself; the values never pass through Claude. Pass the token from vault.import.preview to refuse a file that changed since; conflicts \"update\" makes a new version of the existing item; rewrite swaps each imported .env value for a vault:// reference once it is stored.",
      obj({ file: str, format: str, token: str, conflicts: { type: "string", enum: ["skip", "update"] }, rewrite: { type: "boolean" } }, ["file"]), (input, { caller }) => vault.import(input, caller),
      presence("Import a file into the vault", ({ file, rewrite }) => `Import the items in ${path.resolve(String(file))} into the vault${rewrite ? " and rewrite its .env files to vault references" : ""}`));

    tool("vault.env.scan", SURFACES, "The .env files in your project folders that hold secrets: which project, how many secrets, what kinds, whether git tracks the file, and the command that imports it. Names and counts only, never a value. Import each with vault.import and rewrite, which swaps the values for vault references.",
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

    tool("vault.audit", null, "Who used which item, when, and whether it was allowed. Never a value.",
      obj({ name: str, limit: { type: "integer" } }), input => vault.auditTrail(input));

    tool("vault.match", SURFACES, "Logins for a page, for autofill: names only.",
      obj({ url: str }, ["url"]), input => vault.match(input));

    tool("vault.unlock", PEOPLE, "Unlock a passphrase vault (the first unlock sets the passphrase).",
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
      }, { skip: ({ caller }) => callerKind(caller) === "mcp" }));

    // Reveals no value, only logins, item names and what the policy says, so no presence. Owner
    // callers only: an agent caller has no business mapping who can reach what.
    tool("vault.grants.status", [...SURFACES, "mcp"], "With vault.relay.grants, whether the tailnet policy grants each pass holder vyre.run/cap/vault for what they hold, by whois now or as last seen at the relay.",
      obj({}), async (_input, { caller }) => {
        if (/(?:^|[\s:])agent:/.test(String(caller))) throw new Error("vault.grants.status is for the owner, not an agent");
        return vault.grantsStatus();
      });

    tool("vault.pass.list", null, "Passes this Vyre gave, and passes it holds.", obj({}), () => vault.passes());

    tool("vault.pass.revoke", null, "End a pass. A relayed pass stops at once; a sealed one lists what to rotate.",
      obj({ id: str }, ["id"]), (input, { caller }) => vault.revokePass(input, caller));

    tool("vault.pass.accept", [...SURFACES, "mcp"], "Take a signed pass ticket someone sent you. From Claude it waits for a person to approve it.",
      obj({ ticket: str }, ["ticket"]), (input, { caller }) => vault.accept(input, caller),
      presence("Accept a pass someone sent", ({ ticket }) => {
        const t = decodeTicket(ticket);
        return `Accept a ${t.mode} pass from ${t.owner} holding ${list(t.items)}`;
      }, { skip: ({ caller }) => callerKind(caller) === "mcp" }));

    tool("vault.relay", ["cli", "local", "mcp", "module"], "Use an item someone relayed to you: put {{vault}} (or {{vault.<field>}}) in a header or the body, and their Vyre adds the value.",
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
    tool("vault.emergency.list", null, "Emergency contacts: the wait, where a request stands and when it opens. Names only.",
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
    // A vendor API call with an api-credential: reads run, asked-for sends run, the rest hold at the Gate.
    const requests = requestTools.register({ vault, tool, internal, said, call: ctx.call ? (name, input) => ctx.call(name, input) : undefined, log: ctx.log });

    tool("vault.offboard", [...SURFACES, "mcp"], "Someone left: revoke every pass they hold and list what must be rotated.",
      obj({ person: str }, ["person"]), (input, { caller }) => vault.offboard(input, caller),
      presence("Offboard someone", ({ person }) => `Revoke every pass ${String(person).slice(0, 64)} holds and forget their card`));

    const kits = shareTools.register({ ctx, vault, tool });
    vaultsTools.register({ vault, tool });
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
        breach: { enabled: opts.breach === "ask", fetch: globalThis.fetch },
        connections: conns.connections });

    return {
      ssh: cli.ssh,
      vault,
      connections: conns.connections,
      async stop() {
        if (typeof ctx.provide === "function") ctx.provide("credentialsPort", null); // a stopped vault has no port: the launcher sees none and says so, never a stale answer
        requests.stop();
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

/**
 * The relay listener's meta in whois mode: the login and the peer are whois's answer for the
 * socket's address and nothing else, whatever the request's headers say. Pure, for tests.
 * @param {{ remoteAddress?: string, login?: string|null }} meta
 * @param {ReturnType<typeof import("../link/transport.js").parseWhois>} w
 */
export function whoisMeta(meta, w) {
  const login = w && !w.tagged ? w.login : null;
  return { ...meta, login, ...(w ? { peer: { login, node: w.node, stableId: w.stableId, tags: w.tags, caps: w.caps } } : {}) };
}

/**
 * whois of the online, untagged node signed in as `login`, found in `tailscale status --json`
 * (a shared-in node is in Peer too). On demand only: a new pass with grants required, or
 * vault.grants.status. Null when no such node is online or Tailscale is not there.
 * @param {string} login
 */
async function peerByLogin(login) {
  const r = await tailscale(["status", "--json"], { timeout: 5000 });
  if (r.code !== 0) return null;
  let s;
  try { s = JSON.parse(r.out); } catch { return null; }
  const users = s.User || {};
  const peer = Object.values(s.Peer || {}).find(p => p && p.Online && !(p.Tags || []).length && (p.TailscaleIPs || []).length
    && users[String(p.UserID)] && users[String(p.UserID)].LoginName === login);
  return peer ? whois(peer.TailscaleIPs[0]) : null;
}
