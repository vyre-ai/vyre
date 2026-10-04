// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { ALLOW, ASK_AGAIN, DONT_ALLOW, askTitle, pluginRefusal, pluginView } from "./plugin-model.js";

test("an open ask shows the card, with the computer named", () => {
  const v = pluginView({ granted: false, declined: false }, [{ id: "pa_1", computer: "Alex's Mac" }]);
  assert.deepEqual(v.asks, [{ id: "pa_1", computer: "Alex's Mac" }]);
  assert.equal(v.row, null);
  assert.match(askTitle("Alex's Mac"), /Claude Code on Alex's Mac/);
  assert.deepEqual([ALLOW, DONT_ALLOW], ["Allow", "Don't allow"]);
});

test("the ask-again row shows only while the status says declined", () => {
  assert.deepEqual(pluginView({ granted: false, declined: true }, []).row, { kind: "declined" });
  assert.equal(pluginView({ granted: false, declined: false }, []).row, null);
  assert.equal(ASK_AGAIN, "Let Claude Code ask again");
});

test("a granted Claude Code shows a standing row to remove and no card", () => {
  const v = pluginView({ granted: true, agent: "claude-code-mac", computer: "Mac" }, [{ id: "pa_2", computer: "Mac" }]);
  assert.deepEqual(v, { asks: [], row: { kind: "granted", computer: "Mac" } });
});

test("a refusal has our words and no server text", () => {
  for (const c of ["expired", "conflict", "not_found", "denied", "other", undefined]) assert.ok(pluginRefusal(c) && !/—/.test(pluginRefusal(c)));
  assert.match(pluginRefusal("expired"), /ran out/);
});
