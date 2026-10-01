// @ts-check
// "Answer with" (docs/design/system/components/model-picker.md): which of the person's signed-in AI accounts answers next, read from
// providers.list. Pure: no DOM and no tool calls. Rows are the accounts that can answer (signed in; Claude counts without one),
// each with its plan and models in a line, and the current one marked.

/** @typedef {{ provider: string, account: string|null, label: string, sub: string, now: boolean }} AnswerRow */

/**
 * @param {any} rows providers.list's answer: [{ id, label, accounts: [{ id, label, signed_in, default, plan? }], models: [{ id, label }] }]
 * @param {{ provider?: string|null, account?: string|null }} [current] who answers now (the thread's own provider, and account when known)
 * @returns {AnswerRow[]}
 */
export function answerRows(rows, current = {}) {
  const list = Array.isArray(rows) ? rows : [];
  /** @type {AnswerRow[]} */ const out = [];
  for (const r of list) {
    const provider = String(r?.id ?? r?.provider ?? "").toLowerCase();
    if (!provider) continue;
    const accounts = (Array.isArray(r.accounts) ? r.accounts : []).filter((/** @type {any} */ a) => a && a.signed_in !== false && a.signedIn !== false);
    const models = (Array.isArray(r.models) ? r.models : []).map((/** @type {any} */ m) => String(m?.label || m?.id || "")).filter(Boolean).slice(0, 3);
    // Claude is always there to answer; the others need a signed-in account.
    const rowsFor = accounts.length ? accounts : provider === "claude" ? [{ id: null, label: null }] : [];
    for (const a of rowsFor) {
      const label = String(a.label || r.label || provider);
      const plan = typeof a.plan === "string" && a.plan ? a.plan : "";
      const mine = current.provider === provider && (current.account ? current.account === a.id : accounts.length ? a.default === true || accounts[0] === a : true);
      out.push({ provider, account: a.id ? String(a.id) : null, label, sub: [plan, ...models].filter(Boolean).join(", "), now: !!mine });
    }
  }
  // Only one row is "now": the first that matches.
  let seen = false;
  for (const r of out) { if (r.now && seen) r.now = false; if (r.now) seen = true; }
  return out;
}

/** The chip's words: the account label when this provider has several accounts, else the provider's name. @param {AnswerRow[]} rows @param {string|null|undefined} provider @param {string} name */
export function chipWord(rows, provider, name) {
  const mine = rows.filter(r => r.provider === provider);
  const now = mine.find(r => r.now);
  return mine.length > 1 && now ? now.label : name;
}
