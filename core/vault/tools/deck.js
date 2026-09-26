// @ts-check
// The tools the Deck's Vault app needs that the vault did not have (docs/adr/0006, section 6):
//
//   vault.caps          what this vyred lets the Deck do (reveal is off until floor rule 8 moves)
//   vault.health        Watchtower: names and reason codes, never a value (health.js)
//   vault.breach.check  opt-in, a network call; presence
//   vault.update        add or change an item by merging fields; `generate` makes a value here,
//                       so a new password never enters the page; presence
//
// vault.put stays as it is. vault.update is the Deck's (and a person's) way in: it reads the old
// fields itself, so an edit sends only what the person replaced and never pre-fills a value.

import { judge, breachCheck } from "../health.js";
import { generate as makeValue } from "../generate.js";
import { KINDS } from "../vault.js";
import { callerKind } from "../../modules/index.js";

const str = { type: "string" };
const strs = { type: "array", items: { type: "string" } };
const obj = (properties, required = []) => ({ type: "object", properties, required });
const PEOPLE = ["cli", "local", "deck"];
const FIELD = /^[A-Za-z0-9_.-]{1,64}$/;
/** The field a kind's generator fills when the caller names none. */
const GEN_FIELD = { login: "password", secret: "value", "api-key": "value" };

/**
 * @param {{ ctx: any, vault: import("../vault.js").Vault, fetch?: typeof globalThis.fetch }} deps
 */
export function register({ ctx, vault, fetch = globalThis.fetch }) {
  const opts = () => (ctx.config && ctx.config.vault) || {};

  ctx.tool("vault.caps", {
    description: "What this vyred lets a surface do with the Vault: reveal (off by default), the breach check mode. No value.",
    input: obj({}),
    run: () => {
      const o = opts();
      return { reveal: Boolean(o.deck && o.deck.reveal === true), breach: o.breach === "ask" ? "ask" : "off", host: String((ctx.config && ctx.config.name) || "vyre") };
    },
  });

  ctx.tool("vault.health", {
    description: "Watchtower: items that are weak, reused, old, marked to rotate, missing two-factor or unprotected. Names and reason codes only.",
    input: obj({}),
    run: async (_input, { caller }) => {
      const cols = ctx.store.db.prepare("PRAGMA table_info(vault_items)").all().map(c => String(c.name));
      const classes = cols.includes("class");
      const rows = /** @type {any[]} */ (ctx.store.db.prepare("SELECT * FROM vault_items ORDER BY name").all());
      const items = [];
      for (const r of rows) {
        let fields = {};
        try { fields = await vault.fields(r); } catch (e) {
          // A locked vault stops the whole check; one unreadable item is skipped, by name.
          if (/** @type {any} */ (e).code === "locked") throw new Error("the vault is locked · unlock it to run Watchtower");
          continue;
        }
        let hosts = [];
        try { hosts = JSON.parse(r.hosts || "[]"); } catch {}
        items.push({ name: r.name, kind: r.kind, fields, url: r.url, hosts, updated: r.updated, rotate: r.rotate, class: classes ? r.class : null });
      }
      const out = judge(items, { classes });
      vault.audit("health", null, caller, true, `${out.checked} items, ${out.items.length} flagged`);
      return { ...out, at: Date.now() };
    },
  });

  ctx.tool("vault.breach.check", {
    description: "Opt-in, a network call: sends the first 5 characters of each password's SHA-1 to api.pwnedpasswords.com and compares the rest here. Names only.",
    input: obj({}),
    callers: PEOPLE,
    presence: { summary: async () => "Send the first 5 characters of each password's SHA-1 to api.pwnedpasswords.com" },
    run: async (_input, { caller }) => {
      if (opts().breach !== "ask") throw new Error('the breach check is off · set vault.breach to "ask" in config.json to allow it');
      const rows = /** @type {any[]} */ (ctx.store.db.prepare("SELECT * FROM vault_items WHERE kind = 'login' ORDER BY name").all());
      const entries = [];
      for (const r of rows) {
        try { const f = await vault.fields(r); if (f.password) entries.push({ name: r.name, password: f.password }); } catch (e) {
          if (/** @type {any} */ (e).code === "locked") throw new Error("the vault is locked · unlock it to check for breaches");
        }
      }
      const out = await breachCheck(entries, { fetch });
      vault.audit("breach-check", null, caller, true, `${out.checked} passwords, ${out.breached.length} found in breaches`);
      return { ...out, at: Date.now() };
    },
  });

  ctx.tool("vault.update", {
    description: "Add or change an item by merging fields: only the fields given are replaced, `remove` drops fields, and `generate` makes a new value on this machine that is never returned.",
    input: obj({
      name: str, kind: { type: "string", enum: KINDS }, description: str, url: str, hosts: strs,
      fields: { type: "object" }, remove: strs,
      generate: obj({ field: str, length: { type: "integer" }, words: { type: "integer" }, symbols: { type: "boolean" } }),
    }, ["name"]),
    callers: PEOPLE,
    presence: { summary: async input => {
      const old = vault.row(input.name);
      const what = input.generate ? `, with a new ${input.generate.field || "password"} made on this machine` : "";
      return `${old ? "Change" : "Add"} ${input.kind || (old && old.kind) || "item"} "${input.name}"${what}`;
    } },
    run: async (input, { caller }) => {
      if (!PEOPLE.includes(callerKind(caller))) throw new Error("vault.update is for people");
      const old = vault.row(input.name);
      const kind = input.kind || (old ? old.kind : "secret");
      if (old && input.kind && input.kind !== old.kind) throw new Error(`${input.name} is a ${old.kind}; make a new item to change its kind`);
      const fields = old ? { ...(await vault.fields(old)) } : {};
      for (const [k, v] of Object.entries(input.fields || {})) {
        if (!FIELD.test(k)) throw new Error(`field name "${k}" is not allowed`);
        if (v === null || v === "") delete fields[k]; else fields[k] = v;
      }
      for (const k of input.remove || []) delete fields[k];
      let generated = null, bits = null;
      if (input.generate) {
        const field = input.generate.field || GEN_FIELD[kind];
        if (!field || !FIELD.test(field)) throw new Error("say which field to generate");
        const g = makeValue({ length: input.generate.words ? undefined : (input.generate.length ?? 24), words: input.generate.words, symbols: input.generate.symbols ?? true });
        fields[field] = g.value;
        generated = field; bits = g.bits;
      }
      let hosts = input.hosts;
      if (hosts === undefined && old) { try { hosts = JSON.parse(old.hosts || "[]"); } catch { hosts = []; } }
      const r = await vault.put({ name: input.name, kind, description: input.description ?? (old ? old.description : ""), fields,
        url: input.url !== undefined ? (input.url || undefined) : (old && old.url) || undefined, hosts }, caller);
      const changed = [...Object.keys(input.fields || {}), ...(input.remove || []), ...(generated ? [generated] : [])];
      return { ...r, changed: [...new Set(changed)].sort(), ...(generated ? { generated, bits } : {}) };
    },
  });
}
