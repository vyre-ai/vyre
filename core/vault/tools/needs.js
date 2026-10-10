// @ts-check
// needs: what each module needs from the Vault, and the one way a person fills it (ADR 0028,
// decision 9a). A module declares needs.credentials in its manifest and never asks for a key
// itself; vault.need lists every need with its state and the form to fill it, and vault.connect
// checks what the person gave against the provider catalog, puts the item and grants it.
//
// Who may call: the person's own surfaces only. vault.need reveals names and states, so it needs
// no presence; vault.connect stores a value and gives a module access, so it needs a person, and
// Claude (mcp) is refused outright: a value never comes through Claude. Manifests are read
// through the registry (ctx.modules.status), never from another module's files.
//
// What leaves: names, kinds, states, field names and labels. Never a value, and never a pattern
// matched against one. vault.connected carries {module, need, item, provider}, which is the hook
// the connections table (decision 9b) listens on.

import { presence, quoted } from "./presence.js";
import { isAsker } from "../asker.js";
import { provider as catalog, formFields, checkProviderFields, checkServiceAccount, PROVIDERS } from "../providers.js";
import { classify } from "../../../lib/credential-shapes.js";

const PEOPLE = ["cli", "local", "deck", "capsule"];
const str = { type: "string" };
const obj = (properties, required = []) => ({ type: "object", properties, required });

/** Providers whose secret may be any shape, so credential-shapes.js's guess says nothing about a mix-up. */
const ANY_SHAPE = new Set(["mcp-bearer", "google-apps-script", "imap-smtp"]);
/** credential-shapes.js's word for a catalog provider's family, where the two differ. */
const FAMILY = { "claude-setup-token": "anthropic", "google-oauth": "google", "google-dwd": "google" };

/** A label that names one of a multiple need's items: <module>-<label>. */
const LABEL = /^[a-z0-9][a-z0-9-]{0,40}$/;

/** The item a connect fills: the need's own, or for a multiple need <module>-<label>. */
function itemOf(n, label) {
  if (!n.multiple) return n.item;
  if (!LABEL.test(String(label ?? ""))) throw new Error(`${n.module}'s ${n.id} takes several accounts: give each a label (lowercase letters, digits and dashes), which names its item ${n.module}-<label>`);
  return `${n.module}-${label}`;
}

/**
 * @param {{ ctx: any, vault: import("../vault.js").Vault,
 *   tool: (name: string, callers: string[]|null, description: string, input: any, run: Function, needs?: any) => void }} o
 */
/** The email address an account is known by, from its non-secret fields: the From address, else a username that is one. @param {Record<string, string>} f */
const addressOf = f => [f && f.from, f && f.username].find(x => typeof x === "string" && /^[^\s@]{1,64}@[^\s@]{1,255}$/.test(x));

export function register({ ctx, vault, tool }) {
  /** Every declared need, from the registry's view of the manifests. */
  const declared = () => {
    const mods = ctx.modules && typeof ctx.modules.status === "function" ? ctx.modules.status() : [];
    return mods.filter(m => m.state !== "invalid" && Array.isArray(m.credentials))
      .flatMap(m => m.credentials.map(c => ({ module: m.name, ...c, item: c.multiple ? null : c.item || `${m.name}-${c.id}` })));
  };

  const needOf = (module, id) => {
    const all = declared();
    if (!all.some(n => n.module === module)) throw new Error(`no module named ${String(module).slice(0, 64)} declares needs.credentials`);
    const n = all.find(x => x.module === module && x.id === id);
    if (!n) throw new Error(`${module} declares no need ${String(id).slice(0, 64)}; it needs ${all.filter(x => x.module === module).map(x => x.id).join(", ")}`);
    return n;
  };

  /** Each need's state, from the listing and the pending grants: never a value. */
  const states = needs => {
    const items = new Map(vault.list().items.map(i => [i.name, i]));
    const pending = vault.pending().grants;
    const now = Date.now();
    const one = (n, name) => {
      const it = items.get(name);
      if (!it) return "missing";
      const exp = it.details && it.details.expires;
      if (typeof exp === "number" && exp <= now) return "expired";
      if ((it.grants || []).some(g => g.module === n.module && !g.watcher)) return "ready";
      if (pending.some(g => g.name === name && g.module === n.module && !g.watcher)) return "pending";
      return "not_granted";
    };
    // A multiple need is ready when any of its items is; its items are <module>-<label> of its provider.
    const RANK = ["ready", "pending", "not_granted", "expired", "missing"];
    return needs.map(n => {
      const mine = n.multiple ? [...items.values()].filter(i => i.name.startsWith(`${n.module}-`) && i.details && i.details.provider === n.provider) : [];
      const state = n.multiple ? mine.map(i => one(n, i.name)).sort((a, b) => RANK.indexOf(a) - RANK.indexOf(b))[0] || "missing" : one(n, n.item);
      const p = catalog(n.provider);
      return { module: n.module, id: n.id, kind: n.kind, provider: n.provider, purpose: n.purpose, item: n.item,
        ...(n.multiple ? { multiple: true, items: mine.map(i => ({ name: i.name, state: one(n, i.name) })) } : {}),
        group: n.group ?? null, optional: Boolean(n.optional), state,
        how: p ? p.how : null, fields: formFields(p), help: p ? p.help : null, ...(p && p.next ? { next: { tool: p.next.tool } } : {}) };
    });
  };

  tool("vault.need", PEOPLE, "What each module needs from the Vault (its manifest's needs.credentials): each need's state (ready, missing, not_granted, pending, expired) and how to fill it (how, field names and labels, help). A group is ready when any member is. Never a value.",
    obj({ module: str }), ({ module }) => {
      let all = declared();
      if (module !== undefined) {
        if (!all.some(n => n.module === module)) throw new Error(`no module named ${String(module).slice(0, 64)} declares needs.credentials`);
        all = all.filter(n => n.module === module);
      }
      const needs = states(all);
      /** @type {Map<string, { module: string, group: string, ready: boolean, members: string[] }>} */
      const groups = new Map();
      for (const n of needs) {
        if (!n.group) continue;
        const k = `${n.module}\n${n.group}`;
        const g = groups.get(k) || { module: n.module, group: n.group, ready: false, members: [] };
        g.members.push(n.id);
        if (n.state === "ready") g.ready = true;
        groups.set(k, g);
      }
      return { needs, groups: [...groups.values()] };
    });

  tool("vault.connect", PEOPLE, "Fill one module's need: check the fields (or a dropped service-account file) against the provider catalog, save the item with the need's kind and provider, and grant it to the module. For a sign-in provider it stores nothing and returns next: {tool, input}. Values come from a person's surface, never from Claude.",
    obj({ module: str, need: str, fields: { type: "object" }, file: obj({ content: str, filename: str }, ["content"]), label: str }, ["module", "need"]),
    async ({ module, need: id, fields, file, label }, { caller }) => {
      if (isAsker(caller)) throw new Error("vault.connect takes values from a person's surface, never from Claude");
      const n = needOf(module, id);
      const p = catalog(n.provider);
      if (!p) throw new Error(`${module}'s need ${id} names provider ${n.provider}, which is not in the catalog`);
      if (!p.kinds.includes(n.kind)) throw new Error(`${p.label} is kept as ${p.kinds.join(" or ")}, but ${module} declares ${id} as ${n.kind}`);
      const item = itemOf(n, label);
      const base = { item, module, need: id, provider: p.name };
      if (p.how === "oauth") {
        if (fields !== undefined || file !== undefined) throw new Error(`${p.label} is a sign-in; it takes no fields or file here`);
        return { ...base, granted: false, grant: null, next: { tool: p.next ? p.next.tool : "", input: { name: n.multiple ? String(label) : label || item } } };
      }
      /** @type {Record<string, string>} */
      let clean;
      if (p.how === "file") {
        if (!file || typeof file.content !== "string" || !file.content) throw new Error(`${p.label} needs the key file dropped in`);
        const fileField = p.fields.find(f => f.secret);
        const rest = { ...(fields || {}) };
        if (fileField) delete rest[fileField.name];
        checkServiceAccount(file.content);
        clean = checkProviderFields(p, { ...rest, ...(fileField ? { [fileField.name]: file.content } : {}) });
      } else {
        if (file !== undefined) throw new Error(`${p.label} takes fields, not a file`);
        clean = checkProviderFields(p, fields || {});
        if (!ANY_SHAPE.has(p.name)) {
          const family = FAMILY[/** @type {keyof typeof FAMILY} */ (p.name)] || p.name;
          for (const f of p.fields) {
            if (!f.secret || !clean[f.name]) continue;
            const seen = classify("", clean[f.name]).provider;
            if (seen && seen !== family && (seen in PROVIDERS || Object.values(FAMILY).includes(seen))) throw new Error(`that looks like a key for ${seen}, not ${p.label}`);
          }
        }
      }
      await vault.put({ name: item, kind: n.kind, fields: clean,
        description: String(label || `${p.label} for ${module}: ${n.purpose}`).slice(0, 200),
        details: { provider: p.name, ...(file && file.filename ? { filename: file.filename } : {}), ...(addressOf(clean) ? { address: addressOf(clean) } : {}) } }, caller);
      clean = {};
      const { grant } = await vault.grant({ name: item, module }, caller);
      const granted = grant.status === "active";
      ctx.events.emit("vault.connected", { module, need: id, item, provider: p.name });
      return { ...base, granted, grant };
    },
    presence("Connect a key for a module", ({ module, need: id, label }) => {
      const n = needOf(module, id);
      const p = catalog(n.provider);
      return `Save ${p ? p.label : n.provider} as ${quoted(itemOf(n, label))} and let ${module} use it (${String(n.purpose).slice(0, 80)})`;
    }));
}
