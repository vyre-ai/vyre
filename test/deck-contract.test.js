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

/** Tools the Deck calls that are not on every box, each with why: the Deck must treat it as
 *  optional (a CAPS.use-style missing-tool fallback, never assumed present), so a box that lacks
 *  it is expected, not a bug this test should catch. A tool leaves this list the day every box
 *  registers it - it does not grow to paper over a call nothing answers by design. */
const OPTIONAL = {
  "projects.rename": "teammates ships it in work/teammates-0.2 (core/projects); the Deck shows the action only when the call answers, and says so in a line when it does not. Leaves this list when teammates merges.",
  "projects.archive": "teammates ships it in work/teammates-0.2 (core/projects); the Deck shows the action only when the call answers, and says so in a line when it does not. Leaves this list when teammates merges.",
  "projects.history": "teammates ships it in work/teammates-0.2 (core/projects); the Deck shows the action only when the call answers, and says so in a line when it does not. Leaves this list when teammates merges.",
  "assistant.welcome": "assistant ships it in work/assistant (core/assistant/welcome.js); loadWelcome() treats a missing answer as no welcome row. Leaves this list when assistant merges.",
  "team.retire": "teammates ships it in work/teammates-0.2 (e344434f); the handoff Undo falls back to a plain retire when it is missing or refuses. Leaves this list when teammates merges.",
  "vault.usage": "lives on another machine or module not on every box; falls back when missing.",
  "voice.status": "local/voice is a Mac-local module (deck/chat/core/voice.js); voiceStatus() already treats a missing answer as \"no key\", never assumed present on a box.",
  "voice.listen": "local/voice is a Mac-local module (deck/chat/core/voice.js); listen() already turns a missing answer into \"cannot use voice yet\", never assumed present on a box.",
  "federation.move.plan": "Move to a server is 0.1.2, not 0.1.1 (team/BACKLOG-0.1.2.md); settings.js's drawServer checks modules() for \"federation\" live before ever calling it, so the flow stays off until that module ships.",
  "federation.move.start": "Move to a server is 0.1.2, not 0.1.1 (team/BACKLOG-0.1.2.md); gated the same way as federation.move.plan.",
  "federation.move.status": "Move to a server is 0.1.2, not 0.1.1 (team/BACKLOG-0.1.2.md); gated the same way as federation.move.plan.",
  "federation.move.cancel": "Move to a server is 0.1.2, not 0.1.1 (team/BACKLOG-0.1.2.md); gated the same way as federation.move.plan.",
  "federation.move.confirm": "Move to a server is 0.1.2, not 0.1.1 (team/BACKLOG-0.1.2.md); gated the same way as federation.move.plan.",
  "federation.move.forget": "Move to a server is 0.1.2, not 0.1.1 (team/BACKLOG-0.1.2.md); gated the same way as federation.move.plan.",
};

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
      if (name in OPTIONAL) continue;
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
