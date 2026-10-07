// @ts-check
// `node scripts/eval/assistant-fit/run.js --model <id> --yes --out <dir> [--budget 5]`
// Runs the fit eval against the real Claude API: five short conversations, about five dollars at the most. It refuses to run without ANTHROPIC_API_KEY
// in the environment and an explicit --yes, because it spends money. Tests never run this file.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateModel, formatFit } from "./fit.js";
import { claudeAdapter } from "./adapter-claude.js";
import { openrouterAdapter } from "./adapter-openrouter.js";

/** Dollars per million tokens, by model id; an unknown model uses the eval's high default so the cap errs on stopping early. */
export const PRICES = {
  "anthropic/claude-haiku-4.5": { in: 1, out: 5 },
  "anthropic/claude-sonnet-5.5": { in: 2, out: 10 },
  "openai/gpt-6-sol": { in: 2, out: 10 },
  "google/gemini-3.8-flash": { in: 0.75, out: 3.75 },
  "claude-haiku-4-5-20251001": { in: 1, out: 5 },
};

/** @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {Record<string, string|true>} */ const a = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) { const k = argv[i].slice(2); a[k] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true; }
  return a;
}

/** @param {string[]} argv @param {NodeJS.ProcessEnv} env @param {(s: string) => void} say @returns {Promise<number>} the exit code */
export async function main(argv, env, say) {
  const a = parseArgs(argv);
  if (!a.model || a.model === true) { say("Usage: run.js --model <id> --yes [--out <dir>] [--budget 5]"); return 2; }
  const viaOpenRouter = Boolean(env.OPENROUTER_EVAL_KEY);
  if (!env.ANTHROPIC_API_KEY && !viaOpenRouter) { say("Not run: ANTHROPIC_API_KEY (or OPENROUTER_EVAL_KEY) is not set. This eval calls a real model and spends money."); return 2; }
  if (a.yes !== true) { say("Not run: pass --yes to spend up to the budget (default $5) on real model calls."); return 2; }
  const budgetUsd = a.budget && a.budget !== true ? Number(a.budget) : 5;
  const cap = env.GITHUB_ACTIONS ? 5 : 20;
  if (!(budgetUsd > 0 && budgetUsd <= cap)) { say(`Not run: the budget must be above 0 and at most ${cap} dollars.`); return 2; }
  const r = await evaluateModel({ adapter: viaOpenRouter ? openrouterAdapter({ apiKey: String(env.OPENROUTER_EVAL_KEY), model: String(a.model) }) : claudeAdapter({ apiKey: String(env.ANTHROPIC_API_KEY), model: String(a.model) }), budgetUsd, prices: PRICES });
  say(formatFit(r));
  if (a.out && a.out !== true) {
    fs.mkdirSync(String(a.out), { recursive: true });
    const file = path.join(String(a.out), `fit-${String(a.model).replace(/[^a-z0-9._-]/gi, "_")}.json`);
    fs.writeFileSync(file, JSON.stringify(r, null, 2));
    say(`Wrote ${file}`);
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main(process.argv.slice(2), process.env, s => console.log(s)).then(c => { process.exitCode = c; });
