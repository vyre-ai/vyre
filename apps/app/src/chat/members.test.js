// @ts-check
import assert from "node:assert/strict";
import test from "node:test";
import { awayOf, whereLine } from "./members.js";

test("awayOf: another computer running the chat offers carry on here", () => {
  const places = { places: [{ chat: "chat_1", session: "s1", computer: "Office Mac", device: "dev_office", online: true }] };
  assert.deepEqual(awayOf(places, "chat_1", "dev_phone"), { machine: "dev_office", name: "Office Mac" });
  assert.equal(awayOf(places, "chat_1", "dev_office"), null);
});

test("whereLine: offline computer", () => {
  const places = [{ chat: "c", computer: "MacBook", online: false }];
  assert.equal(whereLine(places, "c"), "MacBook is offline");
});
