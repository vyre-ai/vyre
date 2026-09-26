// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { Apps } from "./local.js";
import { Launcher } from "./launcher.js";
import * as glass from "./glass.js";

const BOX = "https://alex.vyre.run";

/** @returns {any} */
const catalog = (box = BOX) => ({
  box,
  agents: [
    { name: "harper", kind: "agent", computer: true, thread: "t-cur" },
    { name: "juno", kind: "assistant", computer: false },
    { name: "night owl", kind: "agent", computer: true },
  ],
  projects: [],
  threads: [
    { id: "t-1", label: "Rebuild the intake deck", agent: "harper" },
    { id: "t-cur", label: "Quarterly filings" },
    { id: "t-2", label: "Draft the rebuttal", agent: "juno" },
  ],
});

/** A stand-in for execFile that records what it was asked to run. */
function recorder(fail = null) {
  /** @type {{ cmd: string, args: string[] }[]} */
  const calls = [];
  const run = /** @type {any} */ ((cmd, args, cb) => { calls.push({ cmd, args }); cb(fail); });
  return { calls, run };
}

test("glass: the URL is the box's origin, /glass/, then the encoded agent", () => {
  assert.equal(glass.url(BOX, "harper"), "https://alex.vyre.run/glass/harper");
  assert.equal(glass.url(BOX + "/", "box"), "https://alex.vyre.run/glass/box");
  assert.equal(glass.url("https://box.example.ts.net:8443", "harper"), "https://box.example.ts.net:8443/glass/harper");
  assert.equal(glass.url(BOX, "night owl"), "https://alex.vyre.run/glass/night%20owl");
  assert.equal(glass.url(BOX, "a/../b?x#y"), "https://alex.vyre.run/glass/a%2F..%2Fb%3Fx%23y", "a name stays one path segment");
});

test("glass: no box address, or not an https one, is no URL", () => {
  for (const box of [null, undefined, "", "alex.vyre.run", "http://alex.vyre.run", "file:///etc/passwd", "-a Terminal"]) {
    assert.equal(glass.url(box, "harper"), null, String(box));
  }
  assert.equal(glass.url(BOX, ""), null);
});

test("glass: the address comes from link.status, and only for a live pairing", async () => {
  const client = data => ({ call: async tool => (assert.equal(tool, "link.status"), { data }) });
  assert.equal(await glass.address(client({ linked: true, box: { address: BOX + "/" } })), BOX);
  assert.equal(await glass.address(client({ linked: false, box: { address: BOX } })), null);
  assert.equal(await glass.address(client({ linked: true, box: null })), null);
  assert.equal(await glass.address(client({ linked: true, box: { address: "http://alex.vyre.run" } })), null);
  assert.equal(await glass.address({ call: async () => ({ error: { code: "unknown_tool" } }) }), null);
  assert.equal(await glass.address({ call: async () => { throw new Error("down"); } }), null);
  assert.equal(await glass.address(client({ linked: true, box: { address: BOX } }), false), null, "no link.status tool, no call");
});

test("glass: an agent with a computer gets Open Glass, one without does not", () => {
  const r = glass.results("harper", catalog());
  assert.deepEqual(r.map(x => [x.kind, x.id, x.label, x.glass]), [["glass", "glass:harper", "Open Glass · harper", "harper"]]);
  assert.deepEqual(glass.results("juno", catalog()), [], "juno has no computer");
});

test("glass: a thread offers Glass for its agent, by the thread's agent or the agent's current thread", () => {
  assert.deepEqual(glass.results("intake deck", catalog()).map(x => x.glass), ["harper"]);
  assert.deepEqual(glass.results("quarterly", catalog()).map(x => x.glass), ["harper"], "t-cur is harper's current thread");
  assert.deepEqual(glass.results("rebuttal", catalog()), [], "juno's thread, and juno has no computer");
});

test("glass: hidden without a box address, whatever the words", () => {
  for (const box of [null, "", "http://alex.vyre.run"]) {
    for (const q of ["harper", "intake deck", "glass", "glass harper", "glass box"]) assert.deepEqual(glass.results(q, catalog(box)), [], `${box} ${q}`);
  }
  assert.deepEqual(glass.results("harper", null), []);
});

test("glass: the typed command, for an agent, a prefix, the box, or all of them", () => {
  assert.deepEqual(glass.results("glass harper", catalog()).map(x => x.id), ["glass:harper"]);
  assert.deepEqual(glass.results("Glass HAR", catalog()).map(x => x.id), ["glass:harper"]);
  assert.deepEqual(glass.results("glass juno", catalog()), [], "no computer, no row, even when asked by name");
  const box = glass.results("glass box", catalog());
  assert.deepEqual(box.map(x => [x.id, x.label]), [["glass:box", "Open the box's files in Glass"]]);
  assert.deepEqual(glass.results("glass", catalog()).map(x => x.id).sort(), ["glass:box", "glass:harper", "glass:night owl"]);
});

test("glass: open calls the opener with exactly the Glass URL", async () => {
  const { calls, run } = recorder();
  assert.deepEqual(await glass.open(BOX, "night owl", run), { ok: true, close: true });
  assert.deepEqual(calls, [{ cmd: "/usr/bin/open", args: ["https://alex.vyre.run/glass/night%20owl"] }]);
  const none = recorder();
  assert.match(String((await glass.open(null, "harper", none.run)).error), /no box is paired/);
  assert.equal(none.calls.length, 0, "no address, nothing opened");
  const bad = recorder(new Error("open failed"));
  assert.deepEqual(await glass.open(BOX, "harper", bad.run), { error: "open failed" });
});

test("glass: through the launcher, the row ranks and picking it opens the URL built from the catalog, not the page", async () => {
  const { calls, run } = recorder();
  const l = new Launcher({ apps: new Apps({ dirs: [] }), run });
  const q = await l.quick("glass harper", catalog());
  assert.equal(q.results[0].id, "glass:harper");
  assert.equal(q.intent, "open");
  // A page that tampered with the row still gets the box's own URL for the named target.
  const out = await l.pick({ ...q.results[0], target: "https://elsewhere.example/x" }, "glass harper");
  assert.deepEqual(out, { ok: true, close: true });
  assert.deepEqual(calls.map(c => c.args), [["https://alex.vyre.run/glass/harper"]]);
  const after = await l.quick("harper", catalog(null));
  assert.equal(after.results.some(r => r.kind === "glass"), false, "the box went away: no row");
  assert.match(String((await l.pick(q.results[0], "glass harper")).error), /no box is paired/, "and no opening from a stale row");
  assert.equal(calls.length, 1);
});
