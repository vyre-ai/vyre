// @ts-check
// One chat's runs for the Chat list (work.chat.list): its providers and its last line come from threads.of-chat, asked once for each chat the person is in. Each ask has a short budget, so a slow
// run lookup leaves only that row without its providers and last line, and the whole list never waits on it.
import { within } from "../../lib/within.js";

/** How long one chat's runs may take before its row is listed without them. */
export const RUNS_BUDGET_MS = 1500;

/**
 * The chat's runs, or none when the lookup fails or runs past the budget.
 * @param {(tool: string, input: any) => Promise<any>} call @param {string} chat @param {number} [ms] @returns {Promise<any[]>}
 */
export async function chatRuns(call, chat, ms = RUNS_BUDGET_MS) {
  const asked = Promise.resolve().then(() => call("threads.of-chat", { chat })).then((/** @type {any} */ x) => (x && x.data) || {}, () => ({}));
  const got = /** @type {any} */ (await within(asked, ms, null));
  return got && Array.isArray(got.runs) ? got.runs : [];
}
