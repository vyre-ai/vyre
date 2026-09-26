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

import { Vault, MIGRATIONS, KINDS } from "./vault.js";
import fs from "node:fs";
import path from "node:path";
import { serve } from "./relay.js";
import { Fill, FILL_TOOLS, serveFill } from "./fill.js";
import { backup, restore, inspect } from "./backup.js";
import { envName } from "./cli-io.js";
import { callerKind } from "../modules/index.js";
import * as shareTools from "./tools/share.js";

const PEOPLE = ["cli", "local"];
const str = { type: "string" };
const strs = { type: "array", items: { type: "string" } };
const obj = (properties, required = []) => ({ type: "object", properties, required });

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    ctx.store.migrate(MIGRATIONS);
    const vault = new Vault({ db: ctx.store.db, dir: ctx.paths.vault, config: ctx.config, emit: (t, p) => ctx.events.emit(t, p), log: ctx.log });

    const opts = (ctx.config && ctx.config.vault) || {};
    let listener = null;
    if (opts.relay && (opts.relay.port !== undefined || opts.relay.host)) {
      listener = await serve({ host: opts.relay.host || "127.0.0.1", port: Number(opts.relay.port || 0), identity: vault.relayIdentity, onRelay: (env, meta) => vault.onRelay(env, meta) });
      vault.relayUrl = opts.relay.url ? String(opts.relay.url) : listener.url;
      ctx.log(`vault relay listening on ${listener.url}`);
    }

    // Autofill: a listener only browser extensions (and the Capsule's helper) talk to, after
    // pairing and unlock. vault.fill is a route there, never a registry tool, so no agent has it.
    const fill = new Fill({ vault, verifyVaultPassphrase: p => vault.checkPassphrase(p) });
    let fillListener = null;
    if (opts.fill && (opts.fill.port !== undefined || opts.fill.host)) {
      fillListener = await serveFill({ host: opts.fill.host || "127.0.0.1", port: Number(opts.fill.port || 0), fill });
      ctx.log(`vault fill listening on ${fillListener.url}`);
    }

    const tool = (name, callers, description, input, run) => ctx.tool(name, { description, input, callers, run });

    // The pairing code comes with the address the extension must use, so a person has both.
    for (const t of FILL_TOOLS) tool(t.name, t.callers, t.description, t.input, async (input, { caller }) => {
      const r = await fill[t.method](input, caller);
      return t.method === "code" ? { ...r, fill: fillListener ? fillListener.url : null } : r;
    });

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
      });

    tool("vault.restore", PEOPLE, "Restore a backup. merge adds what is missing; replace needs an empty vault.",
      obj({ file: str, passphrase: str, mode: { type: "string", enum: ["merge", "replace"] } }, ["file", "passphrase"]),
      ({ file, passphrase, mode }, { caller }) => restore(vault, fs.readFileSync(path.resolve(file), "utf8").trim(), passphrase, { mode, who: caller }));

    // Modules may put too (onboarding stores the Claude credential this way), but only new items
    // or items they made themselves, and they may grant only what they put: neither reveals a
    // value the module did not already have. `value` is shorthand for fields.value.
    tool("vault.put", ["cli", "local", "module"], "Add or replace an item. Values come from `vyre vault put`'s hidden prompt or a module, never from Claude.",
      obj({ name: str, kind: { type: "string", enum: KINDS }, description: str, value: str, fields: { type: "object" }, url: str, hosts: strs, grants: strs, relay: obj({ body: { type: "boolean" } }) }, ["name"]),
      async ({ value, grants, relay: relayRules, ...input }, { caller }) => {
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
        if (relayRules) vault.share.setRelayRules(input.name, relayRules);
        for (const g of grants || []) vault.grant({ name: input.name, module: g }, caller);
        return { ...out, ...(grants ? { granted: grants } : {}) };
      });

    tool("vault.list", null, "Every item's name, kind, description, field names, hosts and grants. Never a value.",
      obj({ filter: str }), input => vault.list(input));

    tool("vault.delete", PEOPLE, "Delete an item and its grants.",
      obj({ name: str }, ["name"]), (input, { caller }) => vault.remove(input, caller));

    tool("vault.grant", ["cli", "local", "mcp"], "Let a module (or one watcher) use an item through ctx.vault.fetch. From Claude it waits for a person to approve it.",
      obj({ name: str, module: str, watcher: str }, ["name", "module"]), (input, { caller }) => vault.grant(input, caller));

    tool("vault.revoke", null, "Take an item away from a module, or from one of its watchers.",
      obj({ name: str, module: str, watcher: str }, ["name", "module"]), (input, { caller }) => vault.revoke(input, caller));

    tool("vault.pending", ["cli", "local", "mcp"], "Grants and passes an agent asked for, waiting for a person.",
      obj({}), () => vault.pending());

    tool("vault.approve", PEOPLE, "Approve a pending grant or pass.",
      obj({ id: str }, ["id"]), (input, { caller }) => vault.approve(input, caller));

    ctx.tool("vault.release", {
      internal: true,
      description: "One value, to a module holding a grant for it.",
      input: obj({ name: str, field: str, watcher: str }, ["name"]),
      run: (input, { caller }) => vault.release(input, caller),
    });

    tool("vault.inject", PEOPLE, "Values for `vyre vault run`, which puts them in one child process's environment.",
      obj({ items: { type: "array", items: obj({ name: str, env: str, field: str }, ["name"]) } }, ["items"]),
      (input, { caller }) => vault.inject(input, caller, envName));

    tool("vault.totp", ["cli", "local", "module"], "The current one-time code for a login with a TOTP seed.",
      obj({ name: str }, ["name"]), (input, { caller }) => vault.code(input, caller));

    tool("vault.generate", ["cli", "local", "mcp"], "Generate a password or passphrase. With `name` it is stored and never returned; Claude must give a name.",
      obj({ length: { type: "integer" }, words: { type: "integer" }, symbols: { type: "boolean" }, name: str, description: str }),
      (input, { caller }) => {
        if (callerKind(caller) === "mcp" && !input.name) throw new Error("give a name: a generated password is stored, never shown to Claude");
        return vault.generate(input, caller);
      });

    tool("vault.import", ["cli", "local", "mcp"], "Import a .env file or a 1Password, Bitwarden, Chrome or Safari export. vyred reads the file itself; the values never pass through Claude.",
      obj({ file: str, format: str }, ["file"]), (input, { caller }) => vault.import(input, caller));

    tool("vault.audit", null, "Who used which item, when, and whether it was allowed. Never a value.",
      obj({ name: str, limit: { type: "integer" } }), input => vault.auditTrail(input));

    tool("vault.match", PEOPLE, "Logins for a page, for autofill: names only.",
      obj({ url: str }, ["url"]), input => vault.match(input));

    tool("vault.unlock", PEOPLE, "Unlock a passphrase vault (the first unlock sets the passphrase).",
      obj({ passphrase: str }, ["passphrase"]), input => vault.unlock(input.passphrase));

    tool("vault.lock", null, "Forget the key until the next unlock.", obj({}), () => vault.lock());

    tool("vault.identity", null, "This Vyre's public card, to give to someone who will share items with you. It holds no secret.",
      obj({}), () => vault.card());

    tool("vault.pass.create", ["cli", "local", "mcp"], "Share items with another person's Vyre. Relayed by default: the value never leaves this box. From Claude it waits for approval.",
      obj({ holder: str, card: str, items: strs, mode: { type: "string", enum: ["relayed", "sealed"] }, hosts: strs, methods: strs, paths: strs, expires: str, note: str }, ["holder", "items"]),
      (input, { caller }) => vault.createPass(input, caller));

    tool("vault.pass.list", null, "Passes this Vyre gave, and passes it holds.", obj({}), () => vault.passes());

    tool("vault.pass.revoke", null, "End a pass. A relayed pass stops at once; a sealed one lists what to rotate.",
      obj({ id: str }, ["id"]), (input, { caller }) => vault.revokePass(input, caller));

    tool("vault.pass.accept", ["cli", "local", "mcp"], "Take a signed pass ticket someone sent you. From Claude it waits for a person to approve it.",
      obj({ ticket: str }, ["ticket"]), (input, { caller }) => vault.accept(input, caller));

    tool("vault.relay", ["cli", "local", "mcp", "module"], "Use an item someone relayed to you: put {{vault}} (or {{vault.<field>}}) in a header or the body, and their Vyre adds the value.",
      obj({ item: str, owner: str, request: obj({ method: str, url: str, headers: { type: "object" }, body: str }, ["url"]) }, ["item", "request"]),
      (input, { caller }) => vault.relayOut(input, caller));

    tool("vault.offboard", ["cli", "local", "mcp"], "Someone left: revoke every pass they hold and list what must be rotated.",
      obj({ person: str }, ["person"]), (input, { caller }) => vault.offboard(input, caller));

    const kits = shareTools.register({ ctx, vault, tool });

    return {
      async stop() {
        await kits.stop();
        vault.lock();
        if (listener) await listener.close();
        if (fillListener) await fillListener.close();
      },
    };
  },
};
