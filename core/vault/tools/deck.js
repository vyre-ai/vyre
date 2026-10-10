// @ts-check
// The tools the Deck's Vault app needs that the vault did not have (docs/adr/0006, section 6):
//
//   vault.caps          what this vyred lets the Deck do (reveal is on, behind presence: SPEC 11 rule 8)
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
import { DETAILS } from "../../../lib/vault-kinds/kinds.js";
import { callerAllowed } from "../../modules/index.js";
import { httpFetch } from "../../../lib/http.js";

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
export function register({ ctx, vault, fetch = httpFetch }) {
  const opts = () => (ctx.config && ctx.config.vault) || {};

  ctx.tool("vault.caps", {
    description: "What this vyred lets a surface do with the Vault: reveal (needs a presence proof) and the breach check mode. No value.",
    input: obj({}),
    run: () => {
      const o = opts();
      return { reveal: true, breach: o.breach === "ask" ? "ask" : "off", host: String((ctx.config && ctx.config.name) || "vyre") };
    },
  });

  // Vault health for Now (the one calm row): what the daily Watchtower run found and the person has not yet fixed, read from the reminders it keeps. It decrypts nothing and writes nothing, so it can be asked often.
  const HEALTH_FIX = ["reused", "breached", "weak"], HEALTH_ROTATE = ["rotate", "expiring", "expired", "old"];
  ctx.tool("vault.health.summary", {
    callers: ["cli", "local", "deck", "capsule", "device", "tailnet", "module"],
    description: "How many vault items need attention (to rotate, to fix) from the last Watchtower run, counts only, never a name or a value; zero while the person has dismissed it. For the Now screen's one row.",
    input: obj({}),
    run: () => {
      const db = ctx.store.db;
      const has = (/** @type {string} */ t) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t));
      if (!has("vault_reminders")) return { total: 0, rotate: 0, fix: 0, counts: {}, dismissed_until: null };
      const until = has("vault_jobs") ? /** @type {any} */ (db.prepare("SELECT at FROM vault_jobs WHERE name = 'health-dismiss'").get()) : null;
      if (until && Number(until.at) > Date.now()) return { total: 0, rotate: 0, fix: 0, counts: {}, dismissed_until: Number(until.at) };
      /** @type {Record<string, number>} */ const counts = {};
      for (const r of /** @type {any[]} */ (db.prepare("SELECT reason, COUNT(*) AS n FROM vault_reminders WHERE state = 'open' GROUP BY reason").all())) if ([...HEALTH_FIX, ...HEALTH_ROTATE].includes(String(r.reason))) counts[String(r.reason)] = Number(r.n);
      const sum = (/** @type {string[]} */ xs) => xs.reduce((n, k) => n + (counts[k] || 0), 0);
      return { total: sum([...HEALTH_FIX, ...HEALTH_ROTATE]), rotate: sum(HEALTH_ROTATE), fix: sum(HEALTH_FIX), counts, dismissed_until: null };
    },
  });
  ctx.tool("vault.health.dismiss", {
    callers: PEOPLE,
    description: "Hide the vault health row on Now for a while (default a week). The next Watchtower run after that raises it again if items still need attention.",
    input: obj({ days: { type: "integer", minimum: 1, maximum: 90 } }),
    run: (/** @type {any} */ i) => {
      const db = ctx.store.db, days = Math.min(90, Math.max(1, Math.trunc(Number(i && i.days) || 7))), until = Date.now() + days * 86400_000;
      db.exec("CREATE TABLE IF NOT EXISTS vault_jobs (name TEXT PRIMARY KEY, at INTEGER NOT NULL)");
      db.prepare("INSERT OR REPLACE INTO vault_jobs (name, at) VALUES ('health-dismiss', ?)").run(until);
      return { dismissed_until: until };
    },
  });

  ctx.tool("vault.health", {
    // It decrypts every item to judge it and says so in vault_audit, so it is a write; no model has a reason to trigger it.
    callers: ["cli", "local", "deck", "capsule", "device", "tailnet", "module"],
    description: "Watchtower: items that are weak, reused, old, marked to rotate, missing two-factor, missing a passkey the site offers, unprotected, expired or expiring. Names and reason codes only.",
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
        let details = {};
        try { details = JSON.parse(r.details || "{}"); } catch {}
        items.push({ name: r.name, kind: r.kind, fields, url: r.url, hosts, updated: r.updated, rotate: r.rotate, class: classes ? r.class : null, details });
      }
      const out = judge(items, { classes });
      vault.audit("health", null, caller, true, `${out.checked} items, ${out.items.length} flagged`);
      // A nudge, not a finding: Touch ID unlock is the biggest usability win available (no
      // password prompts), and it needs nothing new - only a Mac with a Secure Enclave and a
      // personal vault already started.
      const status = vault.accountStatus();
      const touchid = { enrolled: status.touchid, available: status.account && Boolean(vault.enclave) };
      return { ...out, touchid, at: Date.now() };
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
      fields: { type: "object" }, remove: strs, details: DETAILS,
      generate: obj({ field: str, length: { type: "integer" }, words: { type: "integer" }, symbols: { type: "boolean" } }),
    }, ["name"]),
    callers: PEOPLE,
    presence: { summary: async input => {
      const old = vault.row(input.name);
      const what = input.generate ? `, with a new ${input.generate.field || "password"} made on this machine` : "";
      return `${old ? "Change" : "Add"} ${input.kind || (old && old.kind) || "item"} "${input.name}"${what}`;
    } },
    run: async (input, { caller }) => {
      if (!callerAllowed(PEOPLE, caller)) throw new Error("vault.update is for people");
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
        url: input.url !== undefined ? (input.url || undefined) : (old && old.url) || undefined, hosts, details: input.details }, caller);
      const changed = [...Object.keys(input.fields || {}), ...(input.remove || []), ...(generated ? [generated] : [])];
      return { ...r, changed: [...new Set(changed)].sort(), ...(generated ? { generated, bits } : {}) };
    },
  });
}
