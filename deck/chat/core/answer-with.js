// @ts-check
// "Answer with" (docs/design/system/components/model-picker.md): which of the person's signed-in AI accounts answers next, read from
// providers.list. Pure: no DOM and no tool calls. Rows are the accounts that can answer (signed in; Claude counts without one),
// each with its plan and models in a line, and the current one marked.

/** @typedef {{ id: string, label: string }} ModelChoice */
/** @typedef {{ provider: string, account: string|null, label: string, sub: string, now: boolean, models: ModelChoice[] }} AnswerRow */

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
    const choices = (Array.isArray(r.models) ? r.models : []).filter((/** @type {any} */ m) => m && typeof m.id === "string" && m.id).map((/** @type {any} */ m) => ({ id: String(m.id), label: String(m.label || m.id) }));
    const models = choices.map((/** @type {ModelChoice} */ m) => m.label).slice(0, 3);
    // Claude is always there to answer; the others need a signed-in account.
    const rowsFor = accounts.length ? accounts : provider === "claude" ? [{ id: null, label: null }] : [];
    for (const a of rowsFor) {
      const label = String(a.label || r.label || provider);
      const plan = typeof a.plan === "string" && a.plan ? a.plan : "";
      const mine = current.provider === provider && (current.account ? current.account === a.id : accounts.length ? a.default === true || accounts[0] === a : true);
      out.push({ provider, account: a.id ? String(a.id) : null, label, sub: [plan, ...models].filter(Boolean).join(", "), now: !!mine, models: choices });
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

/** The word a row is addressed by after "@": the provider's name, plus the account's label when that provider has several. @param {AnswerRow} row @param {AnswerRow[]} rows @param {(p: string) => string} nameOf */
export function accountToken(row, rows, nameOf) {
  const several = rows.filter(r => r.provider === row.provider).length > 1;
  const tail = several ? "-" + row.label.replace(/[^\w.]+/g, "-").replace(/^-+|-+$/g, "") : "";
  return nameOf(row.provider) + tail;
}

/**
 * The account a draft asks for this one turn: "@codex ..." or "@Codex-work ...", only at the very start, only when the word is exactly an
 * account's token (or just a provider's id). Returns the mention the box takes ({ kind: "account", id: "codex" | "codex:<account>" }) and the word.
 * An unknown word is nothing here: the composer treats it as a teammate as it always has.
 * @param {string} text @param {AnswerRow[]} rows @param {(p: string) => string} nameOf
 * @returns {{ mention: { kind: "account", id: string, name: string }, token: string }|null}
 */
export function accountAtStart(text, rows, nameOf) {
  const m = /^@([\w.-]+)(?=\s|$)/.exec(String(text ?? ""));
  if (!m) return null;
  const word = m[1].toLowerCase();
  const exact = rows.find(r => accountToken(r, rows, nameOf).toLowerCase() === word && rows.filter(x => x.provider === r.provider).length > 1);
  if (exact) return { mention: { kind: "account", id: exact.account ? `${exact.provider}:${exact.account}` : exact.provider, name: accountToken(exact, rows, nameOf) }, token: m[1] };
  const prov = rows.find(r => r.provider === word || nameOf(r.provider).toLowerCase() === word);
  return prov ? { mention: { kind: "account", id: prov.provider, name: nameOf(prov.provider) }, token: m[1] } : null;
}

/** Whether a model the session reports is this choice: the same id, or the alias inside a longer id ("claude-opus-4-5" is "opus"). @param {string|null|undefined} current @param {string} id */
export const isModel = (current, id) => !!current && (current === id || current.toLowerCase().includes(id.toLowerCase()));
