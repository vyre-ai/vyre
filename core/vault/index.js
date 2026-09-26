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

import { Vault, MIGRATIONS, KINDS, parseExpiry } from "./vault.js";
import fs from "node:fs";
import path from "node:path";
import { serve, decodeTicket } from "./relay.js";
import { Fill, FILL_TOOLS, serveFill } from "./fill.js";
import { backup, restore, inspect } from "./backup.js";
import { envName } from "./cli-io.js";
import { callerKind } from "../modules/index.js";

const PEOPLE = ["cli", "local"];
const str = { type: "string" };
const strs = { type: "array", items: { type: "string" } };
const obj = (properties, required = []) => ({ type: "object", properties, required });
const quoted = n => `"${String(n ?? "").slice(0, 128)}"`;
const list = ns => (Array.isArray(ns) ? ns : []).slice(0, 8).map(n => quoted(n && typeof n === "object" ? n.name : n)).join(", ") + (Array.isArray(ns) && ns.length > 8 ? ` and ${ns.length - 8} more` : "");

/**
 * A presence declaration (ADR 0004, ADR 0006 section 3). The summary names the item, its kind
 * and where it goes, never a value, and never throws: presence's fallback prints the input,
 * which for a put would carry the value.
 * @param {string} fallback @param {(input: any) => string | Promise<string>} [fn] @param {any} [extra]
 */
export function presence(fallback, fn, extra = {}) {
  return { ...extra, summary: async input => { try { return (fn && (await fn(input || {}))) || fallback; } catch { return fallback; } } };
}

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    ctx.store.migrate(MIGRATIONS);
    const vault = new Vault({ db: ctx.store.db, dir: ctx.paths.vault, config: ctx.config, emit: (t, p) => ctx.events.emit(t, p), log: ctx.log });

    const opts = (ctx.config && ctx.config.vault) || {};
    let listener = null;
    if (opts.relay && (opts.relay.port !== undefined || opts.relay.host)) {
      listener = await serve({ host: opts.relay.host || "127.0.0.1", port: Number(opts.relay.port || 0), onRelay: (env, meta) => vault.onRelay(env, meta) });
      vault.relayUrl = opts.relay.url ? String(opts.relay.url) : listener.url;
      ctx.log(`vault relay listening on ${listener.url}`);
    }

    // Autofill: a listener only browser extensions (and the Capsule's helper) talk to, after
    // pairing and unlock. vault.fill is a route there, never a registry tool, so no agent has it.
    const fill = new Fill({ vault, verifyVaultPassphrase: p => vault.checkPassphrase(p) });
    let fillListener = null;
    if (opts.fill && (opts.fill.port !== undefined || opts.fill.host)) {
      fillListener = await serveFill({ host: opts.fill.host || "127.0.0.1", port: Number(opts.fill.port || 0), fill, names: Array.isArray(opts.fill.names) ? opts.fill.names.map(String) : [] });
      ctx.log(`vault fill listening on ${fillListener.url}`);
    }

    /** `needs` is the tool's presence declaration; left out, the tool needs no person. */
    const tool = (name, callers, description, input, run, needs) => ctx.tool(name, { description, input, callers, run, ...(needs ? { presence: needs } : {}) });

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
    tool("vault.put", ["cli", "local", "module"], "Add or replace an item. Values come from `vyre vault put`'s hidden prompt or a module, never from Claude.",
      obj({ name: str, kind: { type: "string", enum: KINDS }, description: str, value: str, fields: { type: "object" }, url: str, hosts: strs, grants: strs }, ["name"]),
      async ({ value, grants, ...input }, { caller }) => {
        if (value !== undefined) input.fields = { ...(input.fields || {}), value };
        if (!input.fields) throw new Error("give the item a value or fields");
        const mod = caller.startsWith("module:") ? caller.slice(7) : null;
        if (!mod && grants) throw new Error("grants on put are for modules; people use vault.grant");
        if (mod) {
          const old = vault.row(input.name);
          if (old && old.origin !== caller) throw new Error(`${input.name} was not made by ${mod}, so ${mod} cannot replace it`);
          input.origin = caller;
        }
        const out = await vault.put(input, caller);
        for (const g of grants || []) vault.grant({ name: input.name, module: g }, caller);
        return { ...out, ...(grants ? { granted: grants } : {}) };
      }, presence("Save an item in the vault", ({ name, kind }) => {
        const old = vault.row(name);
        return `${old ? "Replace" : "Add"} ${kind || (old && old.kind) || "secret"} ${quoted(name)} in the vault`;
      }));

    tool("vault.list", null, "Every item's name, kind, description, field names, hosts and grants. Never a value.",
      obj({ filter: str }), input => vault.list(input));

    tool("vault.delete", PEOPLE, "Delete an item and its grants.",
      obj({ name: str }, ["name"]), (input, { caller }) => vault.remove(input, caller),
      presence("Delete an item from the vault", ({ name }) => `Delete ${quoted(name)} and its grants`));

    tool("vault.grant", ["cli", "local", "mcp"], "Let a module (or one watcher) use an item through ctx.vault.fetch. From Claude it waits for a person to approve it.",
      obj({ name: str, module: str, watcher: str }, ["name", "module"]), (input, { caller }) => vault.grant(input, caller),
      // From Claude a grant only waits as pending, and approving it needs a person, so the proof is skipped there.
      presence("Let a module use a vault item", ({ name, module, watcher }) => `Let ${module}${watcher ? `/${watcher}` : ""} use ${quoted(name)} while you are away`,
        { skip: ({ caller }) => callerKind(caller) === "mcp" }));

    tool("vault.revoke", null, "Take an item away from a module, or from one of its watchers.",
      obj({ name: str, module: str, watcher: str }, ["name", "module"]), (input, { caller }) => vault.revoke(input, caller));

    tool("vault.pending", ["cli", "local", "mcp"], "Grants and passes an agent asked for, waiting for a person.",
      obj({}), () => vault.pending());

    tool("vault.approve", PEOPLE, "Approve a pending grant or pass.",
      obj({ id: str }, ["id"]), (input, { caller }) => vault.approve(input, caller),
      presence("Approve a pending grant or pass", ({ id }) => {
        const p = vault.pending();
        const g = p.grants.find(x => x.id === id);
        if (g) return `Let ${g.module}${g.watcher ? `/${g.watcher}` : ""} use ${quoted(g.name)} while you are away`;
        const s = p.passes.find(x => x.id === id);
        if (s) return `Share ${list(s.items)} with ${s.holder}, ${s.mode}, until ${new Date(s.expires).toISOString().slice(0, 10)}`;
        return "";
      }));

    ctx.tool("vault.release", {
      internal: true,
      description: "One value, to a module holding a grant for it.",
      input: obj({ name: str, field: str, watcher: str }, ["name"]),
      run: (input, { caller }) => vault.release(input, caller),
    });

    tool("vault.inject", PEOPLE, "Values for `vyre vault run`, which puts them in one child process's environment.",
      obj({ items: { type: "array", items: obj({ name: str, env: str, field: str }, ["name"]) } }, ["items"]),
      (input, { caller }) => vault.inject(input, caller, envName),
      presence("Put vault items into a program's environment", ({ items }) =>
        `Put ${(Array.isArray(items) ? items : []).map(i => i && i.env ? `${quoted(i.name)} as ${i.env}` : quoted(i && i.name)).join(", ")} into a program's environment`));

    tool("vault.totp", ["cli", "local", "module"], "The current one-time code for a login with a TOTP seed.",
      obj({ name: str }, ["name"]), (input, { caller }) => vault.code(input, caller),
      // Modules are exempt in the registry; a surface with an open session may skip the proof.
      presence("Show a one-time code", ({ name }) => `Show the one-time code for ${quoted(name)}`,
        { skip: ({ input }) => Boolean(input && /** @type {any} */ (vault).sessions?.ok(input.session, input.name)) }));

    tool("vault.generate", ["cli", "local", "mcp"], "Generate a password or passphrase. With `name` it is stored and never returned; Claude must give a name.",
      obj({ length: { type: "integer" }, words: { type: "integer" }, symbols: { type: "boolean" }, name: str, description: str }),
      (input, { caller }) => {
        if (callerKind(caller) === "mcp" && !input.name) throw new Error("give a name: a generated password is stored, never shown to Claude");
        // Into an existing name is a put by another name (it replaces a login's password), so
        // Claude may only create (ADR 0006 finding 7).
        if (callerKind(caller) === "mcp" && vault.row(input.name)) throw new Error(`${input.name} already exists; Claude may only generate into a new name`);
        return vault.generate(input, caller);
      });

    tool("vault.import", ["cli", "local", "mcp"], "Import a .env file or a 1Password, Bitwarden, Chrome or Safari export. vyred reads the file itself; the values never pass through Claude.",
      obj({ file: str, format: str }, ["file"]), (input, { caller }) => vault.import(input, caller),
      presence("Import a file into the vault", ({ file }) => `Import the items in ${path.resolve(String(file))} into the vault`));

    tool("vault.audit", null, "Who used which item, when, and whether it was allowed. Never a value.",
      obj({ name: str, limit: { type: "integer" } }), input => vault.auditTrail(input));

    tool("vault.match", PEOPLE, "Logins for a page, for autofill: names only.",
      obj({ url: str }, ["url"]), input => vault.match(input));

    tool("vault.unlock", PEOPLE, "Unlock a passphrase vault (the first unlock sets the passphrase).",
      obj({ passphrase: str }, ["passphrase"]), input => vault.unlock(input.passphrase),
      presence("Unlock the vault", () => "Unlock the vault"));

    tool("vault.lock", null, "Forget the key until the next unlock.", obj({}), () => vault.lock());

    tool("vault.identity", null, "This Vyre's public card, to give to someone who will share items with you. It holds no secret.",
      obj({}), () => vault.card());

    tool("vault.pass.create", ["cli", "local", "mcp"], "Share items with another person's Vyre. Relayed by default: the value never leaves this box. From Claude it waits for approval.",
      obj({ holder: str, card: str, items: strs, mode: { type: "string", enum: ["relayed", "sealed"] }, hosts: strs, expires: str, note: str }, ["holder", "items"]),
      (input, { caller }) => vault.createPass(input, caller),
      presence("Share vault items with someone", ({ holder, items, mode, expires }) => {
        let until = "";
        try { until = `, until ${new Date(parseExpiry(expires)).toISOString().slice(0, 10)}`; } catch {}
        return `Share ${list(items)} with ${String(holder).slice(0, 64)}, ${mode === "sealed" ? "sealed (a copy leaves this Vyre)" : "relayed"}${until}`;
      }, { skip: ({ caller }) => callerKind(caller) === "mcp" }));

    tool("vault.pass.list", null, "Passes this Vyre gave, and passes it holds.", obj({}), () => vault.passes());

    tool("vault.pass.revoke", null, "End a pass. A relayed pass stops at once; a sealed one lists what to rotate.",
      obj({ id: str }, ["id"]), (input, { caller }) => vault.revokePass(input, caller));

    tool("vault.pass.accept", ["cli", "local", "mcp"], "Take a pass ticket someone sent you.",
      obj({ ticket: str }, ["ticket"]), (input, { caller }) => vault.accept(input, caller),
      presence("Accept a pass someone sent", ({ ticket }) => {
        const t = decodeTicket(ticket);
        return `Accept a ${t.mode} pass from ${t.owner} holding ${list(t.items)}`;
      }));

    tool("vault.relay", ["cli", "local", "mcp", "module"], "Use an item someone relayed to you: put {{vault}} (or {{vault.<field>}}) in a header or the body, and their Vyre adds the value.",
      obj({ item: str, owner: str, request: obj({ method: str, url: str, headers: { type: "object" }, body: str }, ["url"]) }, ["item", "request"]),
      (input, { caller }) => vault.relayOut(input, caller));

    tool("vault.offboard", ["cli", "local", "mcp"], "Someone left: revoke every pass they hold and list what must be rotated.",
      obj({ person: str }, ["person"]), (input, { caller }) => vault.offboard(input, caller),
      presence("Offboard someone", ({ person }) => `Revoke every pass ${String(person).slice(0, 64)} holds and forget their card`));

    return {
      async stop() {
        vault.lock();
        if (listener) await listener.close();
        if (fillListener) await fillListener.close();
      },
    };
  },
};
