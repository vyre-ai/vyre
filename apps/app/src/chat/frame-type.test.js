import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { kindOf, typeOf, isKind, PREFIX } from "./frame-type.js";

test("a frame's kind reads the same under the session. and chat. prefixes, and the prefix is set in one place", () => {
  assert.equal(kindOf("session.user-message"), "user-message");
  assert.equal(kindOf("chat.user-message"), "user-message");
  assert.equal(kindOf("tool-started"), "tool-started");
  assert.equal(typeOf("status"), `${PREFIX}status`);
  assert.equal(isKind({ type: "chat.status" }, "status"), true);
  assert.equal(isKind({ type: "session.status" }, "text-done"), false);
  assert.equal(isKind(null, "status"), false);
});
