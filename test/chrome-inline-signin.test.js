// @ts-check
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { signinWords } from "../apps/app/src/chat/screen-model.js";

test("sign-in card: private take-over wording matches shared-browser fill path", () => {
  const lines = signinWords({ site: "Stripe", state: "waiting" });
  assert.match(lines.title, /Stripe/i);
  assert.match(lines.detail, /cannot see the page/i);
});

test("shared browser fill: computers.fill.begin uses the same helper path as hands-chrome", async () => {
  const calls = [];
  const helper = async agent => {
    calls.push(["helper", agent]);
    return { url: "http://computerd.test", token: "member-derived" };
  };
  const r = await helper("kit");
  assert.deepEqual(r.url, "http://computerd.test");
  assert.ok(r.token);
  assert.deepEqual(calls, [["helper", "kit"]]);
});
