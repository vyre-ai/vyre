// @ts-check
// Tasks survive a restart (devbox, 4 Oct): they lived in memory only, so every redeploy emptied tasks.list while records stayed. The log now carries each task after every change and the kernel
// rebuilds them at start. A real daemon on a temp home, restarted; a test box, never a Mac.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tempHome } from "./helpers.js";
import { start } from "../core/daemon/index.js";
import { seed } from "../core/records-tools/dev-seed.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";

test("two seeded tasks (one waiting for the person's check, one an assistant works) are listed again after the kernel restarts, in the same states", { timeout: 180_000 }, async t => {
  const root = tempHome(t);
  let d = await start({ root, log: () => {}, kernel: true });
  const me = (/** @type {any} */ x) => x.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-r", person: x.kernel.id.owner, path: "direct", session: "s" });
  const seeded = await seed({ gateway: d.kernel.gateway, surfaces: d.kernel.surfaces, chain: me(d), space: d.kernel.id.space });
  const before = (await d.kernel.gateway.ask.list(me(d), {})).map((/** @type {any} */ x) => [x.id, x.state]).sort();
  assert.equal(before.length, 2);
  await d.stop();
  d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const after = (await d.kernel.gateway.ask.list(me(d), {})).map((/** @type {any} */ x) => [x.id, x.state]).sort();
  assert.deepEqual(after, before, "the same two tasks in the same states: the text comes back from the task store");
  assert.deepEqual((await d.kernel.gateway.ask.needsYou(me(d))).map((/** @type {any} */ x) => x.id), [seeded.tasks.approval], "the approval still waits for the person");
  assert.ok(await d.kernel.gateway.ask.card(me(d), seeded.tasks.approval), "and its card is rebuilt from the stored body, hash-checked");
  const titles = (await d.kernel.gateway.ask.list(me(d), {})).map((/** @type {any} */ x) => x.title);
  assert.ok(titles.every((/** @type {string} */ x) => x && !x.includes("no longer available")), "titles are restored from the store: " + titles.join(" | "));
});

test("TR-1: free text (a title, a note, an answer, a reason) with a sensitive value is never in the log, in any task event, and still survives a restart from the task store", { timeout: 180_000 }, async t => {
  const root = tempHome(t);
  let d = await start({ root, log: () => {}, kernel: true });
  const me = (/** @type {any} */ x) => x.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-r", person: x.kernel.id.owner, path: "direct", session: "s" });
  const space = d.kernel.id.space, gw = d.kernel.gateway;
  const ssn = "123-45-6789";
  const assistant = { kind: "agent", id: "assistant", space };
  // a guarded decision waiting for its check, and an unguarded one completed with an answer
  const waiting = await gw.ask.request(me(d), { title: `Check the file for ${ssn}`, doer: assistant, checker: { kind: "person", id: d.kernel.id.owner, space }, output: { kind: "decision" }, note: `client ssn ${ssn}` });
  const plain = await gw.ask.request(me(d), { title: "Decide", doer: assistant, output: { kind: "decision" } });
  for (const [task, evidence] of [[waiting, { answer: "yes", reason: `the client's ssn ${ssn} matches` }], [plain, { answer: "no", reason: `her ssn is ${ssn}` }]]) {
    const s1 = await d.kernel.surfaces.open(me(d), { agent: "assistant", ttl_ms: 60_000 });
    const ac = await d.kernel.surfaces.chainFor(s1.token);
    await gw.ask.start(ac, task.id);
    await gw.ask.complete(ac, task.id, evidence);
  }
  const everything = () => JSON.stringify(d.kernel.log.read({ type: "task.*" }));
  assert.ok(!everything().includes(ssn), "the number is in the log: " + everything().slice(0, 400));
  assert.match(everything(), /text_hash/, "the log carries the hash of the text");
  const states = async () => (await gw.ask.list(me(d), {})).map((/** @type {any} */ x) => [x.id, x.state, x.title, x.answer === undefined ? null : JSON.stringify(x.answer)]).sort();
  const before = await states();
  await d.stop();
  d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  gw.ask === undefined;
  assert.deepEqual(await (async () => (await d.kernel.gateway.ask.list(me(d), {})).map((/** @type {any} */ x) => [x.id, x.state, x.title, x.answer === undefined ? null : JSON.stringify(x.answer)]).sort())(), before, "titles, states and answers are back from the task store");
  assert.ok(!JSON.stringify(d.kernel.log.read({ type: "task.*" })).includes(ssn), "and still not in the log");
});
