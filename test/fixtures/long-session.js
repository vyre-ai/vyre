// @ts-check
// A long synthetic coding session for the head-to-head's long-session arm (team/0.2.5/memory-context.md,
// scripts/eval-h2h.js). Alex Rivera and an assistant debug a billing webhook service for Northwind
// Bakery across 480 turns. Twenty-nine specific facts (a port, an error code, a file and line, a commit,
// a decision and its reversal) are planted at fixed turns between 12 and 300; the rest is seeded
// filler that looks like a real session (test runs, diffs, logs) and carries near-duplicate numbers on
// purpose, so a question about one port cannot be answered by finding any port. Nothing here is real.
// Deterministic: the same turns every run.

const SEED = 20260930;
/** @param {number} a */
function rng(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rand = rng(SEED);
const pick = /** @template T @param {T[]} xs @returns {T} */ xs => xs[Math.floor(rand() * xs.length)];
const int = (/** @type {number} */ lo, /** @type {number} */ hi) => lo + Math.floor(rand() * (hi - lo + 1));

export const TURN_COUNT = 480;
/** Turns before this index are what compaction folds into a summary; the rest are the verbatim tail. */
export const CUT = 400;

/** @type {{ at: number, role: "user"|"assistant", text: string, q: string, expect: string[] }[]} */
export const PLANTED = [
  { at: 12, role: "assistant", text: "The mock Stripe server now listens on port 41873, because 4000 clashed with the docs server.", q: "Which port did we move the mock Stripe server to?", expect: ["41873"] },
  { at: 20, role: "user", text: "The ledger check failed again with ERR_LEDGER_DRIFT_7731: ledger total 18204 != invoice total 18240.", q: "What was the exact error code when the ledger drifted?", expect: ["ERR_LEDGER_DRIFT_7731"] },
  { at: 31, role: "assistant", text: "Found it: the off-by-one is in src/ledger/reconcile.ts at line 218, where the loop uses <= instead of <.", q: "Which file and line had the off-by-one in the ledger?", expect: ["218"] },
  { at: 44, role: "user", text: "Decision: failed webhooks retry after 5s, 25s and 125s, then go to the dead-letter table. No fourth retry.", q: "What is the longest retry delay before a webhook is dead-lettered?", expect: ["125s", "125 seconds", "125 s"] },
  { at: 52, role: "user", text: "Priya Natarajan owns the Stripe account, so ask her before rotating the restricted key.", q: "Who owns the Stripe account?", expect: ["Priya Natarajan", "Priya"] },
  { at: 61, role: "assistant", text: "To reproduce, run: node scripts/replay.mjs --from evt_1Nq8Zx --dry", q: "What event id did the replay repro command start from?", expect: ["evt_1Nq8Zx"] },
  { at: 73, role: "assistant", text: "The fix landed in commit 9c41e7a on the branch billing-drift.", q: "Which commit fixed the drift?", expect: ["9c41e7a"] },
  { at: 80, role: "user", text: "Set BILLING_REPLAY_WINDOW_SEC to 900 in staging only. Production stays at 3600.", q: "What did we set BILLING_REPLAY_WINDOW_SEC to in staging?", expect: ["900"] },
  { at: 88, role: "assistant", text: "I pinned pg to 8.11.3 because 8.12 broke the connection pool under load.", q: "Which version of pg did we pin, and why not the newer one?", expect: ["8.11.3"] },
  { at: 97, role: "assistant", text: "Created the table ledger_shadow_2026 to hold the shadow copy while we compare totals.", q: "What is the shadow comparison table called?", expect: ["ledger_shadow_2026"] },
  { at: 109, role: "user", text: "We will dedupe webhooks with Redis SETNX keyed on the event id.", q: "What did we first choose for webhook dedupe?", expect: ["Redis"] },
  { at: 131, role: "user", text: "Reversal: drop Redis for dedupe. Use Postgres advisory locks instead, Redis was one more thing to run.", q: "What do we use for webhook dedupe now?", expect: ["advisory"] },
  { at: 140, role: "assistant", text: "The flaky test is test/webhook/retry.spec.ts, case 'dead-letters after the third failure'. It fails about one run in twelve.", q: "Which test case is flaky and how often does it fail?", expect: ["dead-letters after the third failure", "one run in twelve", "retry.spec.ts"] },
  { at: 152, role: "user", text: "The on-call channel is #billing-oncall and the pager alias is billing-primary.", q: "What is the pager alias for billing on-call?", expect: ["billing-primary"] },
  { at: 163, role: "assistant", text: "Memory leak traced to the invoice cache: it kept 20000 entries and never evicted. Cap set to 512 entries.", q: "What did we cap the invoice cache at?", expect: ["512"] },
  { at: 170, role: "user", text: "Northwind's fiscal year starts on 1 March, so the monthly report cutoff is the last day of February for year end.", q: "When does Northwind's fiscal year start?", expect: ["1 March", "March"] },
  { at: 184, role: "assistant", text: "Migration 0047_add_idempotency_index.sql adds a unique index on (event_id, attempt). It takes about 40 seconds on staging.", q: "Which migration added the idempotency index?", expect: ["0047"] },
  { at: 191, role: "user", text: "Use the sandbox customer cus_QXa7m2 for every manual test, never a real customer.", q: "Which sandbox customer id do we use for manual tests?", expect: ["cus_QXa7m2"] },
  { at: 203, role: "assistant", text: "Latency before the fix: p95 1840 ms. After the batch size change from 50 to 200: p95 610 ms.", q: "What was the p95 latency after the batch size change?", expect: ["610"] },
  { at: 214, role: "user", text: "Sam Okafor wants the refund webhook to ignore events older than 72 hours.", q: "How old can a refund event be before it is ignored?", expect: ["72"] },
  { at: 226, role: "assistant", text: "Rollback plan: redeploy release 2026.09.4 and run scripts/unfreeze.sh. Do not touch the ledger table during rollback.", q: "Which release do we roll back to?", expect: ["2026.09.4"] },
  { at: 237, role: "user", text: "The staging database host is nw-billing-stg.internal on port 6543, with pgbouncer in transaction mode.", q: "What port is the staging database on?", expect: ["6543"] },
  { at: 248, role: "assistant", text: "Log line that proved the double charge: 'charge.created dup suppressed key=whk_88f1c2 attempt=2'.", q: "What was the key in the log line that proved the double charge was suppressed?", expect: ["whk_88f1c2"] },
  { at: 259, role: "user", text: "Keep the timezone as America/Chicago for all the billing cron jobs. The nightly job runs at 02:15.", q: "What time does the nightly billing job run?", expect: ["02:15", "2:15"] },
  { at: 268, role: "assistant", text: "The feature flag is called ledger_v2_reconcile and is on for 10 percent of accounts.", q: "What is the feature flag for the new reconcile called?", expect: ["ledger_v2_reconcile"] },
  { at: 277, role: "user", text: "I rejected the idea of a rewrite in Go. We stay on Node, the team knows it.", q: "What language did we decide to stay on instead of rewriting?", expect: ["Node"] },
  { at: 285, role: "assistant", text: "Added a CHECK constraint named ledger_nonneg_total so a negative total cannot be written.", q: "What is the CHECK constraint we added called?", expect: ["ledger_nonneg_total"] },
  { at: 292, role: "user", text: "Invoice numbers use the prefix NWB- followed by six digits, starting at 100200.", q: "What number do invoice numbers start at?", expect: ["100200"] },
  { at: 300, role: "assistant", text: "Summary of the cause: the retry worker read the attempt counter before the transaction committed, so two workers both saw attempt=1.", q: "What was the root cause of the double charge?", expect: ["before the transaction committed", "attempt counter", "attempt"] },
];

const MODS = ["billing", "ledger", "refunds", "webhook", "invoices", "dedupe", "scheduler", "auth", "reports"];
const VERBS = ["Looking at", "Checking", "Reading", "Tracing", "Running", "Comparing", "Rechecking"];
const THINGS = ["the retry worker", "the invoice serializer", "the cron wrapper", "the pool settings", "the event queue", "the audit log", "the test fixtures", "the staging config", "the refund path"];

/** Log lines, so a filler turn is as long as a real tool output and carries near-duplicate ids and numbers. */
function logs(/** @type {number} */ n) {
  const hex = () => Math.floor(rand() * 0xffffff).toString(16).padStart(6, "0");
  return Array.from({ length: n }, () => `  2026-09-${String(int(1, 28)).padStart(2, "0")}T${String(int(0, 23)).padStart(2, "0")}:${String(int(0, 59)).padStart(2, "0")}:${String(int(0, 59)).padStart(2, "0")}Z worker-${int(1, 6)} evt_${hex()} ${pick(["ok", "ok", "ok", "retry", "skipped", "slow"])} ${int(8, 900)}ms queue=${int(0, 400)}`).join("\n");
}

function filler(/** @type {number} */ i) {
  const f = base(i);
  return { role: f.role, text: `${f.text}\n${logs(int(4, 9))}` };
}

function base(/** @type {number} */ i) {
  const m = pick(MODS), kind = int(0, 6);
  switch (kind) {
    case 0: return { role: "assistant", text: `${pick(VERBS)} ${pick(THINGS)}. Ran \`npm test -- ${m}\`: ${int(40, 220)} passed, ${int(0, 3)} failed in ${int(2, 19)}.${int(0, 9)}s. Nothing there points at the ledger yet, so I am moving on to ${pick(THINGS)}.` };
    case 1: return { role: "user", text: `ok. what about ${pick(THINGS)}? last time it was ${pick(["fine", "slow", "noisy", "flaky"])} on my machine, around ${int(100, 900)} ms.` };
    case 2: return { role: "assistant", text: `Local check on localhost:${int(3001, 9999)}: the ${m} route returned ${pick([200, 200, 200, 202, 409, 500])} in ${int(8, 400)} ms. I will try again with the larger payload (${int(2, 90)} KB).` };
    case 3: return { role: "assistant", text: `diff --git a/src/${m}/index.ts b/src/${m}/index.ts\n@@ -${int(10, 400)},${int(3, 9)} +${int(10, 400)},${int(3, 11)} @@\n- const timeout = ${int(100, 5000)};\n+ const timeout = ${int(100, 5000)};\nThat is a small tidy, unrelated to the bug. I will leave it out of the fix commit.` };
    case 4: return { role: "user", text: `${pick(["thanks", "good", "makes sense", "ok go ahead", "hmm, not sure about that", "fine by me"])}. keep going, and tell me if it touches ${pick(MODS)}.` };
    case 5: return { role: "assistant", text: `Log excerpt ${i}: ${pick(["INFO", "WARN", "DEBUG"])} worker-${int(1, 6)} processed ${int(1, 500)} events, ${int(0, 12)} retried, queue depth ${int(0, 900)}, lag ${int(1, 60)}s. Nothing unusual compared to the last run.` };
    default: return { role: "assistant", text: `Notes so far on ${m}: the code path is ${pick(["clean", "tangled", "mostly fine", "worth a refactor later"])}; I touched ${int(1, 5)} files and ran ${int(1, 8)} tests. Next step: ${pick(["add a log", "widen the test", "check the config", "read the migration", "compare staging"])}.` };
  }
}

/** @type {{ n: number, role: "user"|"assistant", text: string }[]} */
export const TURNS = Array.from({ length: TURN_COUNT }, (_, n) => {
  const planted = PLANTED.find(p => p.at === n);
  const t = planted ? { role: planted.role, text: planted.text } : filler(n);
  return { n, role: /** @type {"user"|"assistant"} */ (t.role), text: t.text };
});

/** The questions, each with where its answer sits. */
export const QUESTIONS = PLANTED.map(p => ({ q: p.q, expect: p.expect, at: p.at }));
