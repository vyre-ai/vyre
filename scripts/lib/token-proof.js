// @ts-check
// token-proof (R031-00n): the pure parts of the proof that the small tool core (harness/mcp/core-tools.js) costs a model less than listing every tool, and still gets the work done.
// Ten standard tasks, each with a fixed prompt and a pass check; a parser for Claude Code's stream-json output; a summary per arm; and a dry estimate of what a round costs.
// Nothing here calls a model or reads a key. scripts/token-proof.mjs is the runner.

/** A tool call's name as the box knows it: the MCP prefix gone and tools_call unwrapped to the tool it runs, dots and underscores alike. @param {string} name @param {any} input */
export function toolOf(name, input) {
  const bare = String(name).replace(/^mcp__.*?__/, "");
  const real = bare === "tools_call" && input && typeof input.tool === "string" ? input.tool : bare;
  return real.replace(/\./g, "_");
}

/**
 * The calls a run really made: a tools_run is its steps (each call step named by the tool it runs, as tools_call is unwrapped), so a task that wants a tool is satisfied by a batch that ran it.
 * A tools_run that errored, or was held or refused as a whole, counts as nothing; a script that stopped at a step counts the steps that ran.
 * @param {{ name: string, input?: any, ok?: boolean }[]} calls
 */
export function expand(calls) {
  /** @type {{ name: string, input?: any, ok?: boolean }[]} */ const out = [];
  for (const c of calls) {
    const bare = String(c.name).replace(/^mcp__.*?__/, "");
    if (bare !== "tools_run") { out.push(c); continue; }
    const steps = c.input && Array.isArray(c.input.steps) ? c.input.steps : [];
    for (const st of steps) if (st && typeof st.call === "string") out.push({ name: st.call, input: st.input, ok: c.ok });
  }
  return out;
}

/** @param {{ name: string, input?: any, ok?: boolean }[]} calls @param {string[]} names dotted or underscored @returns {boolean} some call to one of them returned without an error */
export const used = (calls, names) => expand(calls).some((c) => c.ok !== false && names.map((n) => n.replace(/\./g, "_")).includes(toolOf(c.name, c.input)));

/** The world the tasks run in is seeded on the box before a round (scripts/token-proof.mjs seed): `seed` names what each task needs there. */
/** `standIn` is the prompt the stand-in claude (scripts/token-proof-world.mjs run --stand-in) turns into a finished call of that tool, to prove the plumbing without a model. @type {{ id: string, prompt: string, standIn?: string, batch?: boolean, tools: string[], answer?: RegExp, seed: string }[]} */
export const TASKS = [
  { id: "recall", standIn: "tooluse mcp__plugin_vyre_vyre__memory_search", prompt: "Using Vyre, find out what monthly retainer Harlow Legal pays us. Answer in one sentence with the amount.", tools: ["memory.ask", "memory.retrieve", "memory.search", "recall.search"], answer: /4,?200/, seed: "memory fact: Harlow Legal pays a monthly retainer of $4,200" },
  { id: "todo", standIn: "tooluse mcp__plugin_vyre_vyre__planner_add", prompt: "Add a todo in Vyre to renew the notary bond by Friday. Then say it is done.", tools: ["planner.add"], seed: "none" },
  { id: "record", standIn: "tooluse mcp__plugin_vyre_vyre__work_call", prompt: "Find the client record for Dana Whitfield in Vyre and tell me her case type.", tools: ["work.call", "records.list", "records.get"], answer: /probate/i, seed: "a client record: Dana Whitfield, case type probate" },
  { id: "flow", prompt: "Run the Flow called intake-welcome in Vyre with the input {\"name\": \"Test Client\"} and tell me its run status.", tools: ["flows.start"], seed: "an approved Flow named intake-welcome" },
  { id: "connection", prompt: "Using the Stripe connection in Vyre, list the customers (limit 1) and tell me how many came back.", tools: ["vault.request", "mcp.call", "work.call"], seed: "a Stripe Connection with a test key" },
  { id: "vault", standIn: "tooluse mcp__plugin_vyre_vyre__vault_request", prompt: "Without showing me the key, call the Acme API at /v1/status with the stored Acme key and tell me the HTTP status.", tools: ["vault.request"], answer: /\b(200|ok)\b/i, seed: "a vault api-credential named acme for a local stand-in host" },
  { id: "file", standIn: "tooluse mcp__plugin_vyre_vyre__files_search", prompt: "Find the file called engagement-letter in my projects folder with Vyre and show me its first line.", tools: ["files.search", "files.preview"], answer: /engagement/i, seed: "a file engagement-letter.txt in a project folder" },
  { id: "teammate", standIn: "tooluse mcp__plugin_vyre_vyre__team_ask", prompt: "Ask the backend teammate in Vyre to look at the signup error and tell me you asked.", tools: ["team.ask", "agents.ask"], seed: "a project with a backend teammate" },
  { id: "doc", standIn: "tooluse mcp__plugin_vyre_vyre__docs_find", prompt: "Using Vyre, find the docs page that explains how to pair a phone and give me its path.", tools: ["docs.find"], answer: /\.md/, seed: "none (the docs ship with Vyre)" },
  { id: "skill", standIn: "tooluse mcp__plugin_vyre_vyre__skills_find", prompt: "Using Vyre, find the skill that helps keep a password out of a file and give me its id.", tools: ["skills.find", "skills.list"], answer: /vyre\/|use-the-vault/i, seed: "none (Vyre's own skills ship with it)" },
  // The three tasks that need R031-00o (many steps in one call) and R031-00p (results by reference). They are not part of the first ten, so the first ten are the control.
  { id: "chain", batch: true, prompt: "In Vyre, find the client Dana Whitfield, look up her matters, and tell me how many of them are still open (not Closed).", tools: ["work.call", "records.list"], answer: /\b(2|two)\b/i, seed: "Dana Whitfield with three matters: two Open, one Closed" },
  { id: "biglist", batch: true, prompt: "In Vyre, list all the clients and tell me the names of the three that come first alphabetically.", tools: ["work.call", "records.list"], answer: /(?=[\s\S]*Aaron Abbott)(?=[\s\S]*Aaron Acosta)(?=[\s\S]*Aaron Adair)/, seed: "215 clients; the first three alphabetically are Aaron Abbott, Aaron Acosta, Aaron Adair" },
  { id: "both", batch: true, prompt: "In Vyre, look at every matter: how many are Open and how many Closed? Then give me the title of Dana Whitfield's Closed matter.", tools: ["work.call", "records.list"], answer: /(?=[\s\S]*\b162\b)(?=[\s\S]*\b55\b)(?=[\s\S]*Deed transfer)/i, seed: "217 matters: 162 Open and 55 Closed; Dana's Closed matter is Deed transfer" },
];

/**
 * The listing and the features each arm of the proof runs with. Arms differ in nothing else: `core` is the small listing with tools_find and tools_call only (what 0.3.1 had before batching);
 * `core-run` adds tools_run; `core-ref` adds results by reference (results_read and handles); `core-both` adds both. `old` and `old-search` list every tool, as before.
 * @type {Record<string, { env: Record<string, string> }>}
 */
export const ARM_ENV = {
  old: { env: { VYRE_MCP_LISTING: "all", ENABLE_TOOL_SEARCH: "false", VYRE_MCP_FEATURES: "none" } },
  "old-search": { env: { VYRE_MCP_LISTING: "all", ENABLE_TOOL_SEARCH: "true", VYRE_MCP_FEATURES: "none" } },
  core: { env: { VYRE_MCP_LISTING: "", ENABLE_TOOL_SEARCH: "false", VYRE_MCP_FEATURES: "none" } },
  "core-run": { env: { VYRE_MCP_LISTING: "", ENABLE_TOOL_SEARCH: "false", VYRE_MCP_FEATURES: "run" } },
  "core-ref": { env: { VYRE_MCP_LISTING: "", ENABLE_TOOL_SEARCH: "false", VYRE_MCP_FEATURES: "ref" } },
  "core-both": { env: { VYRE_MCP_LISTING: "", ENABLE_TOOL_SEARCH: "false", VYRE_MCP_FEATURES: "" } },
};

/** Did a run pass: the right tool was called and returned without an error, and the answer holds the seeded fact where the task has one. @param {typeof TASKS[number]} task @param {{ calls: { name: string, input?: any, ok?: boolean }[], text: string }} run */
export const passed = (task, run) => used(run.calls, task.tools) && (!task.answer || task.answer.test(run.text));

/**
 * Claude Code's `--output-format stream-json --verbose` lines into one run: its tool calls (each with whether it errored), the final text, and the totals Claude Code itself reports.
 * @param {string} out
 */
export function parseStream(out) {
  /** @type {{ id: string, name: string, input: any, ok?: boolean }[]} */ const calls = [];
  /** @type {any} */ let result = null; let listed = 0;
  for (const line of out.split("\n")) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type === "system" && e.subtype === "init" && Array.isArray(e.tools)) listed = e.tools.filter((/** @type {string} */ t) => /^mcp__/.test(t)).length;
    const parts = e.message && Array.isArray(e.message.content) ? e.message.content : [];
    for (const c of parts) {
      if (e.type === "assistant" && c.type === "tool_use") calls.push({ id: c.id, name: c.name, input: c.input });
      if (e.type === "user" && c.type === "tool_result") { const k = calls.find((x) => x.id === c.tool_use_id); if (k) k.ok = !c.is_error; }
    }
    if (e.type === "result") result = e;
  }
  const u = (result && result.usage) || {};
  return {
    calls: calls.map(({ name, input, ok }) => ({ name, input, ok })), mcpToolsListed: listed, text: String((result && result.result) || ""), error: !result || Boolean(result.is_error),
    usage: { input: Number(u.input_tokens) || 0, output: Number(u.output_tokens) || 0, cacheRead: Number(u.cache_read_input_tokens) || 0, cacheWrite: Number(u.cache_creation_input_tokens) || 0 },
    usd: Number(result && result.total_cost_usd) || 0, ms: Number(result && result.duration_ms) || 0, turns: Number(result && result.num_turns) || 0,
  };
}

/** The numbers per arm over a set of runs: [{ arm, task, pass, usage, usd, ms, turns, calls }]. @param {any[]} rows */
export function summarize(rows) {
  /** @type {Map<string, any>} */ const arms = new Map();
  for (const r of rows) {
    const a = arms.get(r.arm) || { arm: r.arm, runs: 0, pass: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0, ms: 0, turns: 0, calls: 0 };
    a.runs++; a.pass += r.pass ? 1 : 0; a.input += r.usage.input; a.output += r.usage.output; a.cacheRead += r.usage.cacheRead; a.cacheWrite += r.usage.cacheWrite;
    a.usd += r.usd; a.ms += r.ms; a.turns += r.turns; a.calls += r.calls.length; arms.set(r.arm, a);
  }
  return [...arms.values()].map((a) => ({ ...a, tokensIn: a.input + a.cacheRead + a.cacheWrite, usd: Math.round(a.usd * 1e4) / 1e4 }));
}

/** Per million tokens, in US dollars. These are assumptions to be checked against the price list before a paid run; set them with --price. */
export const PRICES = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

/**
 * A dry estimate of one round: every task on every arm, `reps` times. No model is called. Each run is a few turns; the first turn writes the cache for what never changes (Claude Code's own prompt, the tool
 * listing), the later turns read it and add the tool results so far. `shared` says whether runs after the first find that prefix already cached (they do inside the cache's five minutes).
 * @param {{ arms: { name: string, listing: number, turns: number }[], tasks?: number, reps?: number, base?: number, promptTokens?: number, resultTokens?: number, outputPerTurn?: number, shared?: boolean, prices?: typeof PRICES }} o
 */
export function estimate(o) {
  const tasks = o.tasks ?? TASKS.length, reps = o.reps ?? 1, base = o.base ?? 14000, prompt = o.promptTokens ?? 60, result = o.resultTokens ?? 900, out = o.outputPerTurn ?? 220, price = o.prices || PRICES;
  const M = 1e6;
  const arms = o.arms.map((a) => {
    const prefix = base + a.listing;
    let inputFresh = 0, cacheRead = 0, cacheWrite = 0, output = 0;
    for (let t = 1; t <= a.turns; t++) {
      const grown = prompt + (t - 1) * (result + out);                  // what this turn adds beyond the cached prefix
      if (t === 1) { if (o.shared) cacheRead += prefix; else cacheWrite += prefix; inputFresh += prompt; }
      else { cacheRead += prefix + (grown - (result + out)); inputFresh += result + out; }
      output += out;
    }
    const usdPerRun = (inputFresh * price.input + cacheRead * price.cacheRead + cacheWrite * price.cacheWrite + output * price.output) / M;
    const runs = tasks * reps;
    return { arm: a.name, listingTokens: a.listing, turnsPerRun: a.turns, runs, tokensInPerRun: inputFresh + cacheRead + cacheWrite, tokensOutPerRun: output, usdPerRun: Math.round(usdPerRun * 1e4) / 1e4, usd: Math.round(usdPerRun * runs * 100) / 100 };
  });
  return { arms, totalUsd: Math.round(arms.reduce((n, a) => n + a.usd, 0) * 100) / 100, assumptions: { base, promptTokens: prompt, resultTokens: result, outputPerTurn: out, reps, shared: Boolean(o.shared), prices: price } };
}
