import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { flowText, goLive, grantedOf, liveOf, previewOf, publishNew, rollBack, setSecret, statusOf, waitingOnYou } from "./logic.js";

const D = (v, st, pipe) => ({ v, st, by: "kit", when: "now", msg: "m", pipe });
const done = ["done", "done", "done", "done", "done"];
const site = () => ({ id: "intake", name: "Client intake form", type: "App", sp: "harlow", src: ["GitHub repo", "harlow-legal/intake-form", "branch main"], dom: { name: "intake.harlowlegal.com", ok: true }, sec: { Clio: false, Gmail: true }, dep: [D("v13", "preview", ["done", "done", "done", "cur", ""]), D("v12", "live", done), D("v11", "old", done)], logs: { build: [], run: [] } });

test("a preview past its checks waits on a person", () => {
  assert.equal(waitingOnYou(site()), true);
  assert.deepEqual(statusOf(site()), { label: "Waiting on you", tone: "accent" });
  assert.equal(statusOf({ ...site(), dep: [D("v12", "live", done)] }).label, "Live");
});

test("go live promotes the preview and keeps the old version in history", () => {
  const s = goLive(site());
  assert.equal(liveOf(s).v, "v13");
  assert.equal(previewOf(s), undefined);
  assert.equal(s.dep.find((d) => d.v === "v12").st, "old");
});

test("roll back makes an old version live and leaves the other in history", () => {
  const s = rollBack(site(), "v11");
  assert.equal(liveOf(s).v, "v11");
  assert.equal(s.dep.find((d) => d.v === "v12").st, "old");
  assert.equal(rollBack(site(), "v99").dep.length, 3);
});

test("secrets are granted per deployment", () => {
  assert.deepEqual(grantedOf(site()), ["Gmail"]);
  assert.deepEqual(grantedOf(setSecret(site(), "Clio", true)), ["Clio", "Gmail"]);
});

test("the publish Flow reads as text, and a new publication starts in Build", () => {
  assert.match(flowText(site()), /ask role:admin "Go live\?"/);
  const out = publishNew([site()], "artifact", "Pricing explorer");
  assert.equal(out.length, 2);
  assert.equal(out[0].dep[0].pipe[0], "cur");
  assert.equal(publishNew(out, "artifact", "Pricing explorer").length, 2);
});
