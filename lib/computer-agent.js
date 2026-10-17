// @ts-check
// computer-agent: whose computer a browser or hands call means — one rule for every model adapter.
//
// Claude, Codex, Grok and any registered harness all reach vyred as `mcp` or `harness` with an
// agent claim (`mcp:agent:kit`, `harness:agent:kit`, …) or as a person's surface naming `agent`.
// Vendor id never appears here; profiles and CDP are keyed by agent name and agents.uid only.

import { agentClaim } from "../core/modules/index.js";

export const AGENT_NAME_RE = /^[a-z][a-z0-9-]{0,40}$/;

/**
 * Documented caller shapes every adapter must use (test/computer-agent-agnostic.test.js).
 * Replace `<name>` with a real agent name when exercising resolveComputerAgent.
 */
export const AGENT_ADAPTER_CALLER_SHAPES = Object.freeze([
  "mcp:agent:<name>",
  "harness:agent:<name>",
  "cli:agent:<name>",
  "cli agent:<name>",
  "deck:agent:<name>",
  "capsule:agent:<name>",
  "mobile:agent:<name>",
  "module:agent:<name>",
  "agent:<name>",
]);

/**
 * @param {{ agent?: string }} input
 * @param {string} caller
 * @param {(name: string) => Promise<string|null>} kindOf agents.list kind lookup
 */
export async function resolveComputerAgent(input, caller, kindOf) {
  const self = agentClaim(String(caller || ""));
  let agent;
  if (self) {
    if (!input.agent || input.agent === self) agent = self;
    else if ((await kindOf(self)) === "assistant") agent = input.agent;
    else throw new Error(`${self} can only use its own computer, not ${input.agent}'s`);
  } else {
    if (/^(mcp|harness)\b/.test(String(caller || ""))) {
      throw Object.assign(new Error("a model session may only act on its own agent's computer; it names no agent"), { code: "denied" });
    }
    if (!input.agent) throw new Error("say which agent's computer: agent is required");
    agent = input.agent;
  }
  if (!AGENT_NAME_RE.test(String(agent))) throw new Error(`"${agent}" is not an agent name`);
  return String(agent);
}

/** Refuse a bare model session (`mcp`, `harness`, `mcp:thread:…`) acting without an agent claim. @param {string} caller */
export function modelSessionMustClaimAgent(caller) {
  const c = String(caller || "");
  if (!agentClaim(c) && /^(mcp|harness)\b/.test(c)) {
    throw Object.assign(new Error("a model session may only act on its own agent's computer; it names no agent"), { code: "denied" });
  }
}
