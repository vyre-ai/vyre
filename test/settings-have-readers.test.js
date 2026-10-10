// @ts-check
// PLAN.md section 5, minimum 11: every setting shown has a reader. A setting a module declares in module.json appears in
// Settings; if nothing in the code ever reads it, a person changes it and nothing happens. This looks for each declared key
// in the code outside tests. A reader is: the full key as a quoted string anywhere; the key with one dotted part written as a template
// (`spend.${provider}.daily_usd`); a property chain off the config anywhere (`config.publish.servers`); or the key's last word (or its camelCase) in the module's OWN code, as a property, a quoted name or
// an object key (a word with an underscore, or a long one, may also stand bare). A common word that merely appears somewhere in the
// code (model, mode, theme) is not a reader: that is how a key with a common tail used to pass for ever.
// A key with no reader is on DEAD below, with the team that owns it; the list only shrinks: wire the reader, or remove the
// setting, and delete the line.

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set(["node_modules", "vendor", "fixtures", "test", "testing"]);

/** Declared settings with no reader found today, by owner. Remove a line when its reader lands or the setting goes. */
const DEAD = {
  "computers.handback_minutes": "computers",
  "learn.distill_daily": "learn",
  "update.auto_install": "platform",
  "sessions.fallback_model": "sessions", "sessions.send_while_busy": "sessions", "sessions.tool_detail": "sessions", "sessions.max_turns": "sessions",
  "sessions.output_style": "sessions", "sessions.box_teammates": "sessions", "sessions.box_subagents": "sessions",
  // found by the stricter check (2026-10-10, issue 117): shown in Settings, read nowhere in the module's own code
  "presence.confirm_pairing": "presence", "sessions.fast": "sessions", "sessions.folders": "sessions", "sessions.checkpoints": "sessions",
  "vault.lock_idle": "vault", "vault.lock_max": "vault", "vault.lock_on_sleep": "vault", "vault.lock_on_screen_lock": "vault",
};

const esc = (/** @type {string} */ x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * Is the setting `key` read? `all` is the text of the non-test code, `own` the text of the declaring module's own folder.
 * @param {string} all @param {string} own @param {string} key
 */
export function isRead(all, own, key) {
  const segs = key.split("."), last = segs[segs.length - 1] || key;
  if (new RegExp(`["'\`]${esc(key)}["'\`]`).test(all)) return true;
  if (segs.length >= 3) for (let i = 0; i < segs.length; i++) if (new RegExp(segs.map((x, j) => (j === i ? "\\$\\{[^}]+\\}" : esc(x))).join("\\.")).test(all)) return true;
  // a property chain off the loaded config, from any module's code: `config.publish.servers`, `ctx.config?.publish.servers`
  if (segs.length >= 2 && new RegExp(`\\b${esc(segs.slice(0, -1).join("."))}\\??\\.${esc(last)}\\b|\\b${esc(segs[0] || "")}\\??\\.${esc(segs.slice(1).join("."))}\\b`).test(all)) return true;
  const unique = last.includes("_") || last.length > 12;
  for (const n of [last, camel(last)]) {
    if (unique && new RegExp(`\\b${esc(n)}\\b`).test(own)) return true;
    if (new RegExp(`\\.${esc(n)}\\b|["'\`]${esc(n)}["'\`]|\\b${esc(n)}\\s*:`).test(own)) return true;
  }
  return false;
}

function* walk(dir, ext) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP.has(e.name)) yield* walk(p, ext); continue; }
    if (ext(e.name)) yield p;
  }
}
const camel = s => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

test("every setting a module declares has a reader in the code, or is on the shrinking DEAD list", () => {
  /** @type {{ key: string, dir: string }[]} */ const keys = [];
  for (const top of ["core", "modules", "local"]) for (const f of walk(path.join(ROOT, top), n => n === "module.json")) {
    let d; try { d = JSON.parse(fs.readFileSync(f, "utf8")); } catch { continue; }
    for (const k of d.settings || []) if (k && typeof k.key === "string") keys.push({ key: k.key, dir: path.dirname(f) });
  }
  assert.ok(keys.length > 40, "the modules declare their settings");
  const code = [];
  // (the Flows runner reads its settings from kernel/flows: the host hands it the Space's settings, so that folder is a reader too)
  for (const top of ["core", "lib", "modules", "local", "harness", "kernel/flows"]) {
    const dir = path.join(ROOT, top);
    if (fs.existsSync(dir)) for (const f of walk(dir, n => n.endsWith(".js") && !n.endsWith(".test.js"))) code.push(fs.readFileSync(f, "utf8"));
  }
  const all = code.join("\n");
  /** @type {Record<string, string>} */ const ownText = {};
  const own = (/** @type {string} */ dir) => (ownText[dir] ??= [...walk(dir, n => n.endsWith(".js") && !n.endsWith(".test.js"))].map(f => fs.readFileSync(f, "utf8")).join("\n"));
  const unread = keys.filter(k => !isRead(all, own(k.dir), k.key)).map(k => k.key);
  const fresh = unread.filter(k => !(k in DEAD));
  const fixed = Object.keys(DEAD).filter(k => !unread.includes(k));
  assert.deepEqual(fresh, [], `a setting is shown that nothing reads (wire a reader, or remove it):\n${fresh.join("\n")}`);
  assert.deepEqual(fixed, [], `good: these now have a reader or are gone; delete them from DEAD:\n${fixed.join("\n")}`);
});

test("a key is not read just because its last word, or a function with its name, appears in the code", () => {
  const all = 'function confirmPairing() {}\nconst model = 1; cfg.mode; theme;\nsettings.get("ui.real_one"); `spend.${p}.daily_usd`', own = 'const escalate_after = 5; cfg.model';
  assert.equal(isRead(all, "", "presence.confirm_pairing"), false, "a function called confirmPairing is not a reader of presence.confirm_pairing");
  assert.equal(isRead(all, "", "chat.model"), false, "a common last word in other modules is not a reader");
  assert.equal(isRead(all, "", "ui.theme"), false);
  assert.equal(isRead(all, "", "ui.real_one"), true, "the full key quoted is");
  assert.equal(isRead(all, "", "spend.claude.daily_usd"), true, "one dotted part written as a template is");
  assert.equal(isRead("const on = ctx.config.publish.servers === true;", "", "publish.servers"), true, "a property chain off the config, from another module's code, is a read");
  assert.equal(isRead("const on = ctx.config.other.servers === true;", "", "publish.servers"), false, "the same last word under another module is not");
  assert.equal(isRead(all, own, "planner.escalate_after"), true, "a distinctive name in the module's own code is");
  assert.equal(isRead(all, own, "chat.model"), true, "a property read in the module's own code is");
  assert.equal(isRead(all, "const model = 1;", "chat.model"), false, "the bare common word in its own code is still not a read");
});
