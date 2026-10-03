// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { createFakeKernel } from "../../test/fake-kernel.js";
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
  const d = createDoingLine(createFakeKernel().kernel, { project: "p", clock: () => now, onLine: (t, l) => out.push([t, l]) });
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
  const d = createDoingLine(createFakeKernel().kernel, { project: "p", clock: () => now, minIntervalMs: 1, onLine: (t, l) => out.push(l) });
  d.observe("a", tool("Read", "x")); now = 1000; d.observe("a", tool("Read", "y"));
  assert.equal(out.length, 1);
});

test("a finished session clears the line", () => {
  let now = 0;
  const d = createDoingLine(createFakeKernel().kernel, { project: "p", clock: () => now });
  d.observe("research", tool("Read", "x")); now = 61_000; d.observe("research", { type: "thread.finished" });
  assert.equal(d.line("research"), null);
});

test("attach follows the project's events through the kernel for agent actors only, and stops when asked", async () => {
  const f = createFakeKernel();
  const alex = f.person("alex"), research = f.agent("research");
  f.grant(alex, ["record.write"]); f.grant(research, ["record.write"]);
  const out = [];
  const d = createDoingLine(f.kernel, { project: "vyre://spc_test/project/p1", onLine: (t, l) => out.push([t, l]) });
  const off = d.attach(f.chain([alex]));
  await f.kernel.records.create(f.chain([alex]), "note", { text: "x" });
  assert.equal(out.length, 0);
  off();
  assert.equal(typeof off, "function");
});
