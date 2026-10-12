// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { leaks } from "../../../../test/holds.js";
import { previewActions, previewWord, shareWord } from "./preview-model.js";
import { normalizeBlock } from "./blocks.js";

test("a card says one word for its state and offers one verb at a time", () => {
  assert.equal(previewWord("live"), "Live");
  assert.equal(previewWord("crashed"), "Needs attention");
  assert.deepEqual(previewActions({ state: "live", mode: "session" }), { open: true, keep: true, restart: false, log: false, stop: true });
  assert.deepEqual(previewActions({ state: "live", mode: "supervised" }), { open: true, keep: false, restart: true, log: false, stop: true });
  assert.deepEqual(previewActions({ state: "crashed", mode: "supervised" }), { open: false, keep: false, restart: true, log: true, stop: false });
  assert.deepEqual(previewActions({ state: "stopped", mode: "session" }), { open: false, keep: false, restart: false, log: false, stop: false });
  assert.match(shareWord("project"), /project/);
});

test("a preview block keeps its id and title and never an address", () => {
  const b = normalizeBlock({ block: "preview", id: "0a1b2c3d", title: "Intake form", state: "live", mode: "supervised", access: "team", url: "http://127.0.0.1:5100", port: 5100 });
  assert.deepEqual(b, { block: "preview", id: "0a1b2c3d", title: "Intake form", state: "live", source: "port", mode: "supervised", access: "team", thumb: 0 });
  assert.ok(!leaks(b, "5100") && !JSON.stringify(b).includes("http"));
  assert.equal(normalizeBlock({ block: "preview", id: "nope", title: "x" }).block, "text", "a malformed id degrades to text");
});

test("lifeWord: the agent's own server ends with the chat; a kept one keeps running", async () => {
  const { lifeWord } = await import("./preview-model.js");
  assert.equal(lifeWord("session", "live"), "Ends with this chat");
  assert.equal(lifeWord("supervised", "live"), "Keeps running");
  assert.equal(lifeWord("session", "stopped"), "");
});

test("publish from the card: only a preview of files can be published; the site's name is a plain slug of the title; the address is the first domain or the url", async () => {
  const { canPublish, siteNameOf, addressOf, publishWords } = await import("./preview-model.js");
  assert.equal(canPublish({ source: "files", state: "live" }), true);
  assert.equal(canPublish({ source: "files", state: "stopped" }), true, "its folder is still there");
  assert.equal(canPublish({ source: "files", state: "starting" }), false);
  assert.equal(canPublish({ source: "port", state: "live" }), false, "an agent's own server is not a folder of ready files");
  assert.equal(siteNameOf("Intake form: Smith & Co!"), "intake-form-smith-co");
  assert.equal(siteNameOf("  "), "site");
  assert.equal(siteNameOf("A".repeat(80)).length, 40);
  assert.equal(addressOf({ url: "https://x.example", domains: [{ host: "intake.example.com" }] }), "intake.example.com");
  assert.equal(addressOf({ url: "http://pv.localhost:1/", domains: [] }), "http://pv.localhost:1/");
  assert.equal(addressOf(null), "");
  assert.equal(publishWords({ public: false }).later, "Public once the public door is on. Until then the address works on your own devices only.");
  assert.equal(publishWords({ public: true }).later, "");
});

test("a Space still being set up is waited for, and any other answer is not", async () => {
  const { whileSettingUp } = await import("./preview-model.js");
  let n = 0; const waits = [];
  const ready = await whileSettingUp(async () => { if (++n < 3) throw Object.assign(new Error("not yet"), { code: "no_space" }); return "held"; }, { wait: async (ms) => { waits.push(ms); } });
  assert.equal(ready, "held");
  assert.deepEqual(waits, [1500, 1500]);
  await assert.rejects(whileSettingUp(async () => { throw Object.assign(new Error("no"), { code: "forbidden" }); }, { wait: async () => { throw new Error("must not wait"); } }), (e) => e.code === "forbidden");
  let m = 0;
  await assert.rejects(whileSettingUp(async () => { m++; throw Object.assign(new Error("still"), { code: "no_space" }); }, { tries: 3, wait: async () => {} }), (e) => e.code === "no_space");
  assert.equal(m, 3, "it gives up after its tries and says what the box said");
});
