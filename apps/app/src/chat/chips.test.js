import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { chipsOf } from "./chips.js";

test("an account chip becomes the message's own AI choice and is no mention; the other tags stay mentions", () => {
  assert.deepEqual(chipsOf([{ kind: "account", id: "codex:mine" }, { kind: "person", id: "sam" }]), { mentions: ["sam"], account: "codex:mine" });
  assert.deepEqual(chipsOf([{ kind: "account", id: "grok" }]), { account: "grok" });
  assert.deepEqual(chipsOf([{ kind: "record", id: "vyre://s/matter/1" }]), { mentions: ["vyre://s/matter/1"] });
  assert.deepEqual(chipsOf(undefined), {});
});
