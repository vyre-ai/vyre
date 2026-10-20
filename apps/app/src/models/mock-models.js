// @ts-check
// The sample world's AI accounts and models, for the design gallery and the mock store only (EXPO_PUBLIC_VYRE_MOCK): the shape the one model service answers (lib/model-registry.js modelView), with
// sample names. Nothing on a real server reads this.
import { groupsOf } from "./model-choice.js";

const m = (/** @type {any} */ o) => ({ vendor: null, version: null, context: null, max_output: null, price: null, vision: null, tools: null, reasoning: null, efforts: [], default_effort: null, ...o, key: `${o.provider}/${o.id}`, label: o.name });

/** @returns {import("./model-choice.js").ModelGroup[]} */
export function sampleGroups() {
  const accounts = [
    { id: "ac_claude", label: "Claude Max", provider: "claude", kind: "login" },
    { id: "ac_router", label: "OpenRouter key", provider: "openrouter", kind: "api-key" },
  ];
  return groupsOf(accounts, [
    { models: [
      m({ id: "sample-claude-deep", name: "Claude Opus 5.5", provider: "claude", vendor: "Anthropic", version: "2026-09-21", context: 1000000, max_output: 128000, price: { in: 4, out: 20 }, vision: true, tools: true, reasoning: true, efforts: ["low", "medium", "high", "xhigh", "max"], default_effort: "high" }),
      m({ id: "sample-claude-fast", name: "Claude Haiku 5.5", provider: "claude", vendor: "Anthropic", context: 1000000, max_output: 128000, price: { in: 0.1, out: 0.5 }, vision: true, tools: true, reasoning: true, efforts: ["low", "medium", "high", "xhigh", "max"], default_effort: "medium" }),
    ] },
    { models: [
      m({ id: "x-ai/grok-4.7", name: "Grok 4.7", provider: "openrouter", vendor: "SpaceXAI", version: "2026-09-16", context: 500000, max_output: 64000, price: { in: 2, out: 10 }, vision: true, tools: true, reasoning: true, efforts: ["low", "medium", "high", "xhigh"], default_effort: "high" }),
      m({ id: "openai/gpt-5.5", name: "GPT-5.5", provider: "openrouter", vendor: "OpenAI", version: "2026-04-23", context: 1050000, max_output: 128000, price: { in: 1.25, out: 10 }, vision: true, tools: true, reasoning: true, efforts: ["low", "medium", "high", "xhigh"], default_effort: "medium" }),
      m({ id: "acme/plain-chat", name: "Plain Chat", provider: "openrouter", vendor: "Acme", context: 32000, price: { in: 0.2, out: 0.6 }, tools: false }),
    ] },
  ]);
}

/** The same sample accounts as the welcome step's model list has them (onboard.assistant.models: each account with its models). */
export function sampleAccounts() {
  return sampleGroups().map((g) => ({ id: g.account.id, label: g.account.label, provider: g.account.provider, kind: g.account.kind, models: g.models }));
}

/** What the sample chat runs on: the first sample account's first model. */
export function sampleNow() {
  const g = sampleGroups()[0];
  return { account: g.account.id, provider: g.models[0].provider, model: g.models[0].id };
}
