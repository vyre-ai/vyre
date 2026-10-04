// @ts-check
// PLAN.md section 5, minimum 11: every setting shown has a reader. A setting a module declares in module.json appears in
// Settings; if nothing in the code ever reads it, a person changes it and nothing happens. This looks for each declared key
// in the code (the full key, the key's tail, or its camelCase tail, as the settings hub maps keys onto config) outside tests.
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
  "vault.lock_idle": "vault", "vault.lock_max": "vault", "vault.lock_on_sleep": "vault", "vault.lock_on_screen_lock": "vault",
};

function* walk(dir, ext) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP.has(e.name)) yield* walk(p, ext); continue; }
    if (ext(e.name)) yield p;
  }
}
const camel = s => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

test("every setting a module declares has a reader in the code, or is on the shrinking DEAD list", () => {
  const keys = [];
  for (const top of ["core", "modules", "local"]) for (const f of walk(path.join(ROOT, top), n => n === "module.json")) {
    let d; try { d = JSON.parse(fs.readFileSync(f, "utf8")); } catch { continue; }
    for (const k of d.settings || []) if (k && typeof k.key === "string") keys.push(k.key);
  }
  assert.ok(keys.length > 40, "the modules declare their settings");
  const code = [];
  for (const top of ["core", "lib", "modules", "local", "harness"]) {
    const dir = path.join(ROOT, top);
    if (fs.existsSync(dir)) for (const f of walk(dir, n => n.endsWith(".js") && !n.endsWith(".test.js"))) code.push(fs.readFileSync(f, "utf8"));
  }
  const text = code.join("\n");
  const read = key => {
    const tail = key.split(".").slice(1).join(".");
    const last = key.split(".").pop() || key;
    return text.includes(key) || (tail && text.includes(tail)) || new RegExp(`\\b${last}\\b`).test(text) || new RegExp(`\\b${camel(last)}\\b`).test(text);
  };
  const unread = keys.filter(k => !read(k));
  const fresh = unread.filter(k => !(k in DEAD));
  const fixed = Object.keys(DEAD).filter(k => !unread.includes(k));
  assert.deepEqual(fresh, [], `a setting is shown that nothing reads (wire a reader, or remove it):\n${fresh.join("\n")}`);
  assert.deepEqual(fixed, [], `good: these now have a reader or are gone; delete them from DEAD:\n${fixed.join("\n")}`);
});
