// @ts-check
// computers.endpoint for an agent with its own computer: only the verified caller's own Chrome, or one the agents module lets this caller use; every refusal comes before anything is made.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeAgentEndpoint } from "./agent-endpoint.js";
import { resolveComputerAgent } from "../../lib/computer-agent.js";
import { agentClaim } from "../modules/index.js";

function world({ kinds = {}, level = "none" } = {}) {
  /** @type {string[]} */ const made = [];
  const kindOf = async (/** @type {string} */ n) => /** @type {any} */ (kinds)[n] || "agent";
  const endpoint = makeAgentEndpoint({
    resolve: (i, caller) => resolveComputerAgent(i, caller, kindOf), claimOf: agentClaim,
    mayUse: async (_need, agent) => { made.push(`asked ${agent}`); if (level === "none") throw new Error("you cannot use that agent"); },
    place: async a => { made.push(`place ${a}`); }, wake: async a => { made.push(`wake ${a}`); }, endpoint: async a => { made.push(`endpoint ${a}`); return { url: `http://127.0.0.1:1/${a}`, token: `tok-${a}` }; },
  });
  return { endpoint, made };
}

test("a model session gets its own agent's Chrome, whichever vendor's adapter it came through, and is woken for it", async () => {
  for (const caller of ["mcp:agent:kit", "harness:agent:kit", "cli:agent:kit"]) {
    const w = world();
    assert.deepEqual(await w.endpoint({}, caller), { helper: { url: "http://127.0.0.1:1/kit", token: "tok-kit" } });
    assert.deepEqual(w.made, ["place kit", "wake kit", "endpoint kit"], caller);
  }
});

test("an agent's session cannot name another agent's endpoint, nor can a session with no claim, nor a bare model session: nothing is made", async () => {
  for (const [caller, input] of [["mcp:agent:kit", { agent: "ads" }], ["harness:agent:kit", { agent: "ads" }], ["mcp", {}], ["mcp", { agent: "ads" }], ["harness", { agent: "ads" }], ["mcp:thread:x", { agent: "ads" }]]) {
    const w = world();
    await assert.rejects(() => w.endpoint(input, caller), /own computer|names no agent|only act on its own/, `${caller} ${JSON.stringify(input)}`);
    assert.deepEqual(w.made, [], "no place, no wake, no ticket");
  }
});

test("the assistant acting for a person reaches another agent's Chrome only if the agents module lets that person use the agent; refused before anything is made", async () => {
  const no = world({ kinds: { helper: "assistant" }, level: "none" });
  await assert.rejects(() => no.endpoint({ agent: "ads" }, "mcp:agent:helper"), /cannot use that agent/);
  assert.deepEqual(no.made, ["asked ads"]);
  const yes = world({ kinds: { helper: "assistant" }, level: "use" });
  assert.equal((await yes.endpoint({ agent: "ads" }, "mcp:agent:helper")).helper.token, "tok-ads");
  assert.deepEqual(yes.made, ["asked ads", "place ads", "wake ads", "endpoint ads"]);
});
