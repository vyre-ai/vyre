// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { sealMemberBrowserOnHandback, beginPrivateMemberBrowser } from "./member-browser-handback.js";

test("member browser handback: seals export and restores agent snapshot", async () => {
  const calls = [];
  const agentBrowser = { mode: () => "browser" };
  const shared = {
    async ensureMember(agent) {
      assert.equal(agent, "kit");
      return { computerId: "browser-box", agentId: "agt_kit" };
    },
  };
  const browserProfiles = {
    async exportContext(computerId, agentId) {
      calls.push(["export", computerId, agentId]);
      return { v: 1, cookies: [{ name: "member", value: "1", domain: "x", path: "/" }] };
    },
    async persistMember(computerId, personId, state) {
      calls.push(["persist", computerId, personId, state.cookies[0].name]);
    },
    async importContext(computerId, agentId, state) {
      calls.push(["import", computerId, agentId, state.cookies[0].name]);
    },
    async restoreMember() { calls.push(["restore"]); },
  };
  const snap = { v: 1, cookies: [{ name: "agent", value: "0", domain: "x", path: "/" }] };
  await beginPrivateMemberBrowser({ agentBrowser, shared, browserProfiles }, "kit", "per_owner");
  assert.deepEqual(calls[0], ["export", "browser-box", "agt_kit"]);
  assert.deepEqual(calls[1], ["restore"]);
  await sealMemberBrowserOnHandback({ agentBrowser, shared, browserProfiles }, "kit", { personId: "per_owner", browserSnap: snap });
  assert.deepEqual(calls.slice(2), [
    ["export", "browser-box", "agt_kit"],
    ["persist", "browser-box", "per_owner", "member"],
    ["import", "browser-box", "agt_kit", "agent"],
  ]);
});
