// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { deviceHistory } from "./device-history.js";

const mac = { mac: "m1", name: "Alex's Mac", ok: true, data: { sources: [
  { kind: "claude", agent: "claude-code", sessions: 3, bytes: 3000, from: 1000, to: 3000, folders: [
    { cwd: "/home/alex/Work/harlow", sessions: 2, bytes: 2000, from: 1000, to: 2000, name: "Harlow", suggested: true },
    { cwd: "/tmp/scratch", sessions: 1, bytes: 1000, from: 2500, to: 3000, suggested: false, why: "a temporary folder" } ] },
  { kind: "codex", agent: "codex", sessions: 2, bytes: 800, from: 500, to: 900, folders: [{ cwd: "/home/alex/Work/northwind", sessions: 2, bytes: 800, from: 500, to: 900, suggested: true }] },
  { kind: "grok", agent: "grok", sessions: 0, bytes: 0, folders: [] },
] } };

test("a Mac with history: per agent and project counts and dates, ticked unless Vyre would not suggest it, one honest sentence", () => {
  const r = deviceHistory([mac]);
  assert.equal(r.found, true);
  assert.equal(r.sessions, 5);
  assert.equal(r.summary, "Found 5 sessions on Alex's Mac, in 3 projects.");
  const d = r.devices[0];
  assert.deepEqual(d.agents.map((/** @type {any} */ a) => a.agent), ["claude-code", "codex"], "an agent with no folders is not listed");
  assert.deepEqual(d.agents[0].folders.map((/** @type {any} */ f) => [f.cwd, f.ticked]), [["/home/alex/Work/harlow", true], ["/tmp/scratch", false]]);
  assert.equal(d.agents[0].folders[1].why, "a temporary folder");
});

test("nothing found is said as nothing found, never as done: no computer, an empty one, one that did not answer", () => {
  assert.match(deviceHistory([]).summary, /^No computer is paired yet\. Go back to Your devices to pair one/);
  const empty = deviceHistory([{ mac: "m1", name: "Alex's Mac", ok: true, data: { sources: [] } }]);
  assert.equal(empty.found, false);
  assert.match(empty.summary, /^Found nothing on Alex's Mac\. It has no Claude Code, Codex or Grok history/);
  const off = deviceHistory([{ mac: "m1", name: "Alex's Mac", ok: false, error: { code: "mac_offline", message: "the Mac is offline" } }]);
  assert.equal(off.found, false);
  assert.match(off.summary, /did not answer/);
  assert.equal(off.devices[0].online, false);
});

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ALLOW } from "../link/allow.js";

test("the box may ask a Mac for import.offer only: read-only, reach modules, and no folder to name", () => {
  assert.ok(ALLOW.includes("import.offer"));
  const here = path.dirname(fileURLToPath(import.meta.url));
  const m = JSON.parse(fs.readFileSync(path.join(here, "..", "import", "module.json"), "utf8"));
  const t = m.does.tools.find((/** @type {any} */ x) => (x.name || x) === "import.offer");
  assert.equal(t.reach, "modules");
  const src = fs.readFileSync(path.join(here, "..", "import", "index.js"), "utf8");
  const offer = src.slice(src.indexOf('ctx.tool("import.offer"'));
  assert.match(offer.slice(0, 700), /input: \{ type: "object", properties: \{\} \}/, "no folders input");
  assert.match(offer.slice(0, 700), /scanDevice\(undefined, false\)/);
});
