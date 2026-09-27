// @ts-check
// Every tool call the Deck makes, checked against the tools a real box registers: the tool exists
// and its input carries every required key. The Deck is built against fixtures, which answer
// whatever they are asked, so a Deck call that no real tool accepts passed every test and failed
// on the user's box ("Give kit a computer" sent agent to agents.update, which requires name).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../core/daemon/index.js";
import { tempHome, present } from "./helpers.js";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Tools the Deck calls that live on another machine or module not on a box, and fall back when missing. */
const ELSEWHERE = new Set(["vault.usage"]);

/** Every .js file under deck/, but not its tests or vendored code. */
function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "vendor" || e.name === "test" ? [] : files(p);
    return e.name.endsWith(".js") && !e.name.endsWith(".test.js") ? [p] : [];
  });
}

/** The first-level keys of an object literal starting at s[i] === "{", or null if it spreads. */
function keysAt(s, i) {
  let depth = 0, key = "", keys = [], expectKey = true, str = null;
  for (let j = i; j < s.length; j++) {
    const ch = s[j];
    if (str) { if (ch === "\\") j++; else if (ch === str) str = null; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { str = ch; continue; }
    if ("{[(".includes(ch)) { depth++; if (depth === 1) { expectKey = true; key = ""; } continue; }
    if ("}])".includes(ch)) { depth--; if (depth === 0) { if (expectKey && /^\w+$/.test(key.trim())) keys.push(key.trim()); return keys; } continue; }
    if (depth !== 1) continue;
    if (s.startsWith("...", j)) return null;
    if (ch === ":" && expectKey) { keys.push(key.trim()); expectKey = false; key = ""; continue; }
    if (ch === ",") { if (expectKey && /^\w+$/.test(key.trim())) keys.push(key.trim()); expectKey = true; key = ""; continue; }
    if (expectKey) key += ch;
  }
  return null;
}

test("deck: every tool the Deck calls exists on a box and gets its required input", async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", computers: { driver: "fake", sweepMs: 0 } }));
  const d = await start({ presence: present, root, log: () => {} });
  t.after(() => d.stop());
  const tools = new Map(d.registry.listTools().map(x => [x.name, x.input || {}]));
  const bad = [];
  for (const file of files(path.join(REPO, "deck"))) {
    const s = fs.readFileSync(file, "utf8");
    for (const m of s.matchAll(/\b(?:attempt|call|callWithCode)\(\s*"([a-z][a-z0-9-]*\.[a-z0-9.-]+)"\s*(,\s*)?/g)) {
      const [, name] = m;
      const where = `${path.relative(REPO, file)}:${s.slice(0, m.index).split("\n").length}`;
      if (ELSEWHERE.has(name)) continue;
      const schema = tools.get(name);
      if (!schema) { bad.push(`${where} calls ${name}, which no module on a box registers`); continue; }
      const at = (m.index ?? 0) + m[0].length;
      const keys = m[2] && s[at] === "{" ? keysAt(s, at) : m[2] ? null : [];
      if (!keys) continue; // input built elsewhere or spread: not checkable here
      for (const k of schema.required || []) if (!keys.includes(k)) bad.push(`${where} calls ${name} without ${k}, which it requires`);
    }
  }
  assert.deepEqual(bad, []);
});
