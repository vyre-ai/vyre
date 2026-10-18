// @ts-check
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { bandOf } from "../lib/prompt-band.js";

test("the band is decided from kernel facts: approved Flow text and a person with use right now are instructions, everything else is information", () => {
  const table = /** @type {[string, any, string][]} */ ([
    ["approved Flow text", { flowStep: true, flowApproved: true }, "instructions"],
    ["Flow text edited after approval (the live draft)", { flowStep: true, flowApproved: false }, "information"],
    ["Flow text with no approved version known", { flowStep: true }, "information"],
    ["a member who holds use on the agent", { requesterUses: true }, "instructions"],
    ["a member without use", { requesterUses: false }, "information"],
    ["no facts at all", {}, "information"],
    ["a tainted chain (email, form, webhook), even from a member with use", { requesterUses: true, tainted: true }, "information"],
    ["approved Flow text on a tainted chain", { flowStep: true, flowApproved: true, tainted: true }, "information"],
    ["a task made by an agent with no person behind it", { byAgent: true }, "information"],
    ["a task made by an agent acting for a person with use", { byAgent: true, actsForUses: true }, "instructions"],
    ["an agent's task for a person with use, on a tainted chain", { byAgent: true, actsForUses: true, tainted: true }, "information"],
    ["a requester with use does not make an agent's task instructions", { byAgent: true, requesterUses: true }, "information"],
    ["a value substituted into approved Flow text", { flowStep: true, flowApproved: true, substituted: true }, "information"],
    ["a teammate request from another agent", { teammate: true, requesterUses: true }, "information"],
  ]);
  for (const [what, facts, band] of table) assert.equal(bandOf(facts), band, what);
});
