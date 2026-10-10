// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { getStarted } from "./get-started.js";
import { GAP } from "../install/first-run.js";

const ASSISTANT = { title: "Create your assistant", body: "It reads your mail.", action: "Create", href: "/u/settings/assistants/new" };

test("a new Mac with no phone and no assistant gets one card with the two steps in order", () => {
  const c = getStarted(GAP.mac, ASSISTANT);
  assert.equal(c && c.title, "Get started");
  assert.deepEqual(c && c.steps.map((s) => [s.title, s.action, s.route]), [["Add your phone", "Add your phone", "/u/install/phone"], ["Create your assistant", "Create", "/u/settings/assistants/new"]]);
});

test("with only one of the two, or a device that cannot reach a Vyre, nothing is combined", () => {
  assert.equal(getStarted(GAP.mac, null), null, "the phone banner shows by itself");
  assert.equal(getStarted(null, ASSISTANT), null, "the assistant card shows by itself");
  assert.equal(getStarted(GAP.web, ASSISTANT), null, "a browser with no Vyre cannot make an assistant");
  assert.equal(getStarted(GAP.phone, ASSISTANT), null);
});
