// @ts-check
// What a provider taking over a chat is handed (owner, 20 Oct 2026: "the context of chat and everything remains exactly the same as we switch the model"). A switch used to hand over the last 20,000
// characters of the conversation and no tool outputs. Now it hands over the whole conversation and every tool call with what it was given and what it returned, written as plain text: the one format
// every provider takes as its first message (Claude Code, Codex and Grok read a prompt; an API-key chat reads the same words), so a Claude session's tool results reach a Grok or an OpenRouter model
// as readably as a Codex session's reach Claude. The budget is the new model's own context window, read from the one model service (core/models); past it the oldest part is summarised (rollover.js
// seedOf) and the chat says so in one quiet line (summarisedLine). Tool outputs come from the sessions' own transcripts through Recall (recall.transcript: each call's input and output, redacted and
// capped as Recall caps them); a provider whose transcript holds no tool calls still has its receipts in the seed.
import { providerName } from "./switched.js";

/**
 * The share of the new model's window the handed-over conversation may take (the rest is its instructions, its tools and its reply), the characters per token of the estimate, the bounds, the window
 * assumed when the model service does not know the model, and how many tool calls are read.
 */
export const CARRY = Object.freeze({ share: 0.5, charsPerToken: 3.5, maxChars: 1_500_000, minChars: 20_000, fallbackWindow: 200_000, inputChars: 600, outputChars: 8_000, calls: 400 });

/** @param {unknown} s @param {number} n */
const clip = (s, n) => { const t = typeof s === "string" ? s : s == null ? "" : JSON.stringify(s); return t.length > n ? `${t.slice(0, n)} [+${t.length - n} characters]` : t; };

/**
 * The new model's context window and its real name, from the one model service; the fallback window and the model's id when the service does not list it.
 * @param {any} sb the Switchboard @param {string} provider @param {string | null | undefined} model @returns {Promise<{ context: number, name: string }>}
 */
export async function windowOf(sb, provider, model) {
  const fallback = { context: CARRY.fallbackWindow, name: model ? String(model) : providerName(provider) };
  if (!model) return fallback;
  try {
    const r = await sb.deps.call("models.list", { provider, available: true, limit: 500 });
    const list = r && !r.error && r.data && Array.isArray(r.data.models) ? r.data.models : [];
    const hit = list.find((/** @type {any} */ m) => m && m.id === model);
    if (!hit) return fallback;
    return { context: Number(hit.context) > 0 ? Number(hit.context) : CARRY.fallbackWindow, name: String(hit.name || hit.label || model) };
  } catch { return fallback; }
}

/**
 * Every tool call of the thread's sessions, oldest first, after `since` (ms): its name, what it was given and what it returned, from each session's transcript (recall.transcript). A session Recall
 * cannot read (none indexed, the module off) gives none; the seed's receipts still say what each call did.
 * @param {any} sb @param {string[]} chain the thread's native sessions, oldest first @param {number} [since]
 * @returns {Promise<{ name: string, input: string, output: string, error: boolean, at: number }[]>}
 */
export async function resultsOf(sb, chain, since = 0) {
  /** @type {{ name: string, input: string, output: string, error: boolean, at: number }[]} */ const out = [];
  for (const session of chain.slice(-12)) {
    let r = null;
    try { r = await sb.deps.call("recall.transcript", { session: String(session), from: 0, limit: 2000 }); } catch { r = null; }
    const blocks = r && !r.error && r.data && Array.isArray(r.data.blocks) ? r.data.blocks : [];
    for (const b of blocks) {
      if (!b || b.kind !== "tool") continue;
      const at = Number(b.ts) || 0;
      if (since && at && at <= since) continue;
      out.push({ name: String(b.tool || "tool"), input: clip(b.input, CARRY.inputChars), output: clip(b.output, CARRY.outputChars), error: b.error === true, at });
    }
  }
  return out.slice(-CARRY.calls);
}

/**
 * What a switch to `provider` and `model` carries: the seed's limits from the model's window (the whole conversation when it fits, no turn cut short), the tool calls with their results, and the
 * model's name for the one quiet line said when the oldest part had to be summarised.
 * @param {any} sb @param {{ chain: string[], provider: string, model?: string | null, since?: number }} o
 */
export async function carryFor(sb, { chain, provider, model = null, since = 0 }) {
  const w = await windowOf(sb, provider, model);
  const budget = Math.max(CARRY.minChars, Math.min(CARRY.maxChars, Math.floor(w.context * CARRY.share * CARRY.charsPerToken)));
  const results = await resultsOf(sb, chain, since);
  return { name: w.name, window: w.context, results, limits: { seedChars: budget, tailChars: budget, turnChars: budget, receipts: CARRY.calls } };
}

/** The one quiet line a chat says when a switch had to summarise its oldest part. @param {string} name the new model's real name */
export const summarisedLine = (name) => `The oldest part of this chat was summarised to fit ${name}'s context.`;
