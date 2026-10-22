import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { heldFromFrames, heldFromRead } from "./index-hold.js";
import { removedFromChat } from "./members.js";

const out = { code: "not_found", message: "no such chat (work.chat.list shows the chats you may see)" };

test("a leave frame for the viewer holds the chat out of search, a join lets it back, and anyone else changes nothing", () => {
  const me = "person:per_kit";
  assert.equal(heldFromFrames(false, me, [{ type: "chat.participant-left", data: { who: me } }]), true);
  assert.equal(heldFromFrames(false, me, [{ type: "chat.participant-left", data: { who: "person:per_alex" } }]), false);
  assert.equal(heldFromFrames(true, me, [{ type: "chat.text-delta", data: { text: "still here" } }]), true, "no leave frame, and the chat stays open, keeps the hold");
  assert.equal(heldFromFrames(true, me, [{ type: "chat.participant-joined", data: { who: me } }]), false);
  assert.equal(heldFromFrames(false, "", [{ type: "chat.participant-left", data: { who: me } }]), false, "no viewer yet is not a leave");
});

test("a membership read that says you are not in the chat holds it out, and a read that lists you lets it back", () => {
  assert.equal(removedFromChat("per_kit", null, out), true);
  assert.equal(removedFromChat("per_kit", null, { code: "offline", message: "Cannot reach your server right now." }), false);
  assert.equal(removedFromChat("per_kit", null, { code: "not_found", message: "no tool work.chat.get" }), false);
  assert.equal(removedFromChat("per_kit", { people: ["per_alex"] }, null), true);
  assert.equal(removedFromChat("per_kit", { people: ["per_kit", "per_alex"] }, null), false);
  assert.equal(removedFromChat(null, null, null), false);
  assert.equal(heldFromRead(false, { me: "per_kit", got: null, err: out }), true);
  assert.equal(heldFromRead(true, { me: "per_kit", got: null, err: { code: "offline", message: "later" } }), true, "a missed read keeps the hold");
  assert.equal(heldFromRead(true, { me: "per_kit", got: { people: ["per_kit"] }, err: null }), false);
  assert.equal(heldFromRead(false, { me: null, got: null, err: null }), false);
});
