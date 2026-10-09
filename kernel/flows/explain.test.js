// @ts-check
// t3: explain this run, in plain words.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, install, settle } from "./testing/world.js";
import { explainRun } from "./describe.js";
import { sourceHash } from "./schema.js";

const flowOf = (/** @type {any[]} */ steps) => ({ format: 1, name: "t", label: "Welcome", authorship: "human", trigger: { on: "event", event: "payment.received" }, steps });
const src = "return { n: 1 };";
const fn = (/** @type {string} */ id, extra = {}) => ({ id, kind: "fn", language: "js", source: src, hash: sourceHash(src), inputs: {}, outputs: ["n"], ...extra });
const coded = (/** @type {string} */ code) => Object.assign(new Error(`port said ${code}`), { code });
const fire = async (/** @type {any} */ w) => { w.kernel.inbound("payment.received", { n: 1, secret: "hunter2" }); await settle(w); return (await w.runner.listRuns())[0]; };
const flowOfRun = async (/** @type {any} */ w, /** @type {any} */ run) => (await w.store.getVersion(run.flow, run.version)).flow;

test("t3: a finished run says why it ran, what it did, and that it finished", async () => {
  const w = await world({});
  await install(w, flowOf([{ id: "m", kind: "create", type: "matter", label: "the matter", set: { client: "Jane" } }]));
  const run = await fire(w);
  const text = explainRun(run, await flowOfRun(w, run));
  assert.match(text, /^A record event started it/);
  assert.match(text, /made the matter/);
  assert.match(text, /It finished\.$/);
  assert.ok(text.split(/(?<=\.) /).length <= 4, text);
  assert.doesNotMatch(text, /hunter2|Jane/);
});

test("t3: a failed run says where it stopped and what a person can do", async () => {
  const w = await world({ ports: { sandbox: async () => { throw coded("bad_output"); } } });
  await install(w, flowOf([fn("f", { retry: false, label: "the letter" })]));
  const run = await fire(w);
  const text = explainRun(run, await flowOfRun(w, run));
  assert.match(text, /It stopped at the letter \(bad_output\); retry it, skip that step, or stop the run\./);
});

test("t3: a run waiting for a person's yes says so, and a held run says why", async () => {
  const w = await world({});
  await install(w, flowOf([{ id: "ok", kind: "ask", to: "role:attorney", title: "Send the email?", label: "the email" }]));
  const run = await fire(w);
  const text = explainRun(run, await flowOfRun(w, run));
  assert.match(text, /waiting for a person's yes on the email/, text);
  assert.match(explainRun({ ...run, state: "queued", queued: { reason: "box_limit" } }, null), /held \(box limit\)/);
});
