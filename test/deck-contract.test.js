// @ts-check
// Every tool call the Deck makes, checked against the tools a real box registers: the tool exists
// and its input carries every required key. The Deck is built against fixtures, which answer
// whatever they are asked, so a Deck call that no real tool accepts passed every test and failed
// on the user's box ("Give kit a computer" sent agent to agents.update, which requires name).

import "../scripts/mac-test-guard.mjs";
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
  "github.star.status": "github ships it (0.2.2, asked in CHAT.md); the star button shows nothing on a box without it. Leaves this list when github merges.",
  "github.star": "github ships it (0.2.2, asked in CHAT.md); only called after status says connected and not starred. Leaves this list when github merges.",
  "watchers.card": "watchers ships it (work/watchers 4e04a220); the watcher card reads it only after a proposal and says so in a line when it fails. Leaves this list when watchers merges.",
  "watchers.create": "watchers ships it (work/watchers 4e04a220); the watcher card reads it only after a proposal and says so in a line when it fails. Leaves this list when watchers merges.",
  "watchers.pause": "watchers ships it (work/watchers 4e04a220); the watcher card reads it only after a proposal and says so in a line when it fails. Leaves this list when watchers merges.",
  "watchers.resume": "watchers ships it (work/watchers 4e04a220); the watcher card reads it only after a proposal and says so in a line when it fails. Leaves this list when watchers merges.",
  "connectors.scope": "connectors ships it (asked in CHAT.md) for changing who can use an existing connection; the control says so in a line when it fails. Leaves this list when connectors merges.",
  "relay.devices.trust": "tailnet ships it; the trust prompt only appears after a device.trust-asked event, and says so in a line when the call fails. Leaves this list when tailnet merges.",
  "team.list": "teammates ships it in work/teammates-0.2 (core/team); the project Team tab says so in a line when the box has no teammates module. Leaves this list when teammates merges.",
  "team.default.get": "teammates ships it in work/teammates-0.2 (core/team); the project Team tab says so in a line when the box has no teammates module. Leaves this list when teammates merges.",
  "team.default.set": "teammates ships it in work/teammates-0.2 (core/team); the project Team tab says so in a line when the box has no teammates module. Leaves this list when teammates merges.",
  "team.status": "teammates ships it in work/teammates-0.2 (core/team); the project Team tab says so in a line when the box has no teammates module. Leaves this list when teammates merges.",
  "team.notes": "teammates ships it in work/teammates-0.2 (core/team); the project Team tab says so in a line when the box has no teammates module. Leaves this list when teammates merges.",
  "team.duties.list": "teammates ships it in work/teammates-0.2 (core/team); the project Team tab says so in a line when the box has no teammates module. Leaves this list when teammates merges.",
  "team.duties.enable": "teammates ships it (4d1a3c3d); the Team tab says so in a line when it fails. Leaves this list when teammates merges.",
  "team.duties.disable": "teammates ships it (4d1a3c3d); the Team tab says so in a line when it fails. Leaves this list when teammates merges.",
  "team.duties.update": "teammates ships it in work/teammates-0.2 (core/team); the project Team tab says so in a line when the box has no teammates module. Leaves this list when teammates merges.",
  "team.duties.run-now": "teammates ships it in work/teammates-0.2 (core/team); the project Team tab says so in a line when the box has no teammates module. Leaves this list when teammates merges.",
  "team.role.fill": "teammates ships it in work/teammates-0.2 (core/team); the project Team tab says so in a line when the box has no teammates module. Leaves this list when teammates merges.",
  "team.add": "teammates ships it in work/teammates-0.2 (core/team); the project Team tab says so in a line when the box has no teammates module. Leaves this list when teammates merges.",
  "team.charter.get": "teammates ships it in work/teammates-0.2 (core/team); the project Team tab says so in a line when the box has no teammates module. Leaves this list when teammates merges.",
  "team.charter.set": "teammates ships it in work/teammates-0.2 (core/team); the project Team tab says so in a line when the box has no teammates module. Leaves this list when teammates merges.",
  "team.charter.draft": "teammates ships it in work/teammates-0.2 (core/team); the project Team tab says so in a line when the box has no teammates module. Leaves this list when teammates merges.",
  "spend.raise": "iq ships it (work/iq 90eb2f4f); the spend cap line and the Settings Spend section say so in a line when the box has no spend module. Leaves this list when iq merges.",
  "spend.summary": "iq ships it (work/iq 90eb2f4f); the spend cap line and the Settings Spend section say so in a line when the box has no spend module. Leaves this list when iq merges.",
  "connectors.catalog": "connectors ships it in work/connectors-0.2 (CHAT.md 11:40); the Add a service list checks the answer and says so in a line when the box has no connectors module. Leaves this list when connectors merges.",
  "connectors.connect": "connectors ships it in work/connectors-0.2 (CHAT.md 11:40); the Add a service list checks the answer and says so in a line when the box has no connectors module. Leaves this list when connectors merges.",
  "connectors.connect.finish": "connectors ships it in work/connectors-0.2 (CHAT.md 11:40); the Add a service list checks the answer and says so in a line when the box has no connectors module. Leaves this list when connectors merges.",
  "connectors.connect.cancel": "connectors ships it in work/connectors-0.2 (CHAT.md 11:40); the Add a service list checks the answer and says so in a line when the box has no connectors module. Leaves this list when connectors merges.",
  "connectors.disconnect": "connectors ships it in work/connectors-0.2 (CHAT.md 11:40); the Add a service list checks the answer and says so in a line when the box has no connectors module. Leaves this list when connectors merges.",
  "mentions.search": "platform ships it (the # tag picker, CHAT.md); the composer checks CAPS and offers nothing when the box has no such tool. Leaves this list when platform merges.",
  "assistant.daily": "assistant ships it in work/assistant; homePath() falls back to the assistant's own thread, then Now. Leaves this list when assistant merges.",
  "team.charter.history": "teammates ships it in work/teammates-0.2 (core/team); the charter notice draws only after the event, and says so in a line when a call fails. Leaves this list when teammates merges.",
  "team.charter.diff": "teammates ships it in work/teammates-0.2 (core/team); the charter notice draws only after the event, and says so in a line when a call fails. Leaves this list when teammates merges.",
  "team.charter.revert": "teammates ships it in work/teammates-0.2 (core/team); the charter notice draws only after the event, and says so in a line when a call fails. Leaves this list when teammates merges.",
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
