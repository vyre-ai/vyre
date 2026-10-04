// @ts-check
// The doing-now line. The line logic is pure (events in, at most one line a minute out) and takes no kernel; `attach` follows a project's events through the REAL
// kernel's event log (test/kernel-rig.js), for agent actors only.
import "../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createRig } from "../../../test/kernel-rig.js";
import { createDoingLine, lineOf } from "./doing.js";

const tool = (name, summary) => ({ type: "thread.tool", data: { name, summary } });

test("a tool event becomes the line under the stage", () => {
  assert.equal(lineOf(tool("WebFetch", "https://harlowlegal.com/about")), "reading harlowlegal.com");
  assert.equal(lineOf(tool("Read", "/work/intake/notes.md")), "reading notes.md");
  assert.equal(lineOf(tool("Bash", "")), "running");
  assert.equal(lineOf({ type: "thread.finished" }), null);
  assert.equal(lineOf({ type: "thread.text", data: { delta: "x" } }), undefined);
});

test("a line goes out at most once a minute per teammate, and the newest waits for the next event or tick", () => {
  let now = 0;
  const out = [];
  const d = createDoingLine(null, { project: "p", clock: () => now, onLine: (t, l) => out.push([t, l]) });
  d.observe("research", tool("WebFetch", "https://harlowlegal.com"));
  assert.deepEqual(out, [["research", "Research is reading harlowlegal.com"]]);
  now = 10_000;
  d.observe("research", tool("Write", "note.md"));
  assert.equal(out.length, 1, "inside the minute: held");
  assert.equal(d.line("research"), "Research is reading harlowlegal.com");
  now = 59_999; d.tick();
  assert.equal(out.length, 1);
  now = 60_000; d.tick();
  assert.deepEqual(out.at(-1), ["research", "Research is writing note.md"]);
  d.observe("intake", tool("Read", "a.md"));
  assert.equal(out.length, 3, "another teammate has its own minute");
  assert.equal(d.line("intake"), "Intake is reading a.md");
});

test("a smaller interval is not honoured: nothing publishes faster than 60 seconds", () => {
  let now = 0; const out = [];
  const d = createDoingLine(null, { project: "p", clock: () => now, minIntervalMs: 1, onLine: (t, l) => out.push(l) });
  d.observe("a", tool("Read", "x")); now = 1000; d.observe("a", tool("Read", "y"));
  assert.equal(out.length, 1);
});

test("a finished session clears the line", () => {
  let now = 0;
  const d = createDoingLine(null, { project: "p", clock: () => now });
  d.observe("research", tool("Read", "x")); now = 61_000; d.observe("research", { type: "thread.finished" });
  assert.equal(d.line("research"), null);
});

test("attach follows the project's events through the kernel for agent actors only, and stops when asked", async () => {
  const rig = await createRig({ agents: ["research"] });
  const project = `vyre://${rig.space}/project/p1`;
  const out = [];
  const d = createDoingLine(rig.kernel, { project, onLine: (t, l) => out.push([t, l]) });
  const off = d.attach(rig.ownerChain);
  const append = (/** @type {any} */ chain, /** @type {string} */ type, /** @type {any} */ data) => rig.k.log.append(chain, { type, sv: 1, subject: `${project}/session`, data });
  await append(rig.ownerChain, "thread.tool", { name: "Read", summary: "a.md" });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(out.length, 0, "a person's event is not a teammate's line");
  await append(rig.assistant("per_alex", "research"), "thread.tool", { name: "WebFetch", summary: "https://harlowlegal.com" });
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(out, [["research", "Research is reading harlowlegal.com"]]);
  off();
  assert.equal(typeof off, "function");
});
