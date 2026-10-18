// A node:test reporter that counts, per test file, the tests that really ran (passed, failed, skipped or todo; suites and the file itself are not tests).
// It writes JSON { "<repo-relative file>": N } to the path in VYRE_TEST_COUNTS_OUT when the run ends. scripts/test-counts.mjs compares that with test/test-counts.json.
import fs from "node:fs";
import path from "node:path";

/** @param {unknown} v @returns {string} */
function show(v) {
  try { return (typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v, null, 1) ?? String(v)).slice(0, 600); } catch { return String(v).slice(0, 600); }
}

/** The text of one failed test: its file, name, the assertion's message, expected and actual, and the start of its stack, at most 60 lines. @param {string} rel @param {any} d @returns {string} */
function failureText(rel, d) {
  const wrapped = d.details?.error;
  const err = wrapped && wrapped.cause && typeof wrapped.cause === "object" ? wrapped.cause : wrapped;
  const lines = [`FAILED TEST ${rel}: ${d.name}`];
  if (err) {
    lines.push(...String(err.message ?? err).split("\n"));
    if (err.expected !== undefined) lines.push(`expected: ${show(err.expected)}`);
    if (err.actual !== undefined) lines.push(`actual: ${show(err.actual)}`);
    if (err.stack) lines.push(...String(err.stack).split("\n").slice(0, 8));
  }
  return lines.slice(0, 60).map(l => l.slice(0, 300)).join("\n") + "\n";
}

/** @param {AsyncIterable<{ type: string, data: any }>} source */
export default async function* countReporter(source) {
  /** @type {Record<string, number>} */ const counts = {};
  /** @type {Record<string, string[]>} the tests that reported skip or todo, by file (test/must-run.json names the ones that may not) */ const skipped = {};
  const root = process.cwd();
  for await (const ev of source) {
    if (ev.type !== "test:pass" && ev.type !== "test:fail") continue;
    const d = ev.data;
    if (!d.file || d.details?.type === "suite") continue;
    // A shard file (sessions-b.test.js imports sessions.test.js) registers its tests in the file it imports: the runner names the file it started in VYRE_TEST_COUNTS_FILE, so each shard is counted, and guarded, on its own.
    const rel = process.env.VYRE_TEST_COUNTS_FILE ? process.env.VYRE_TEST_COUNTS_FILE : path.relative(root, d.file).split(path.sep).join("/");
    // A file that crashed or was cancelled reports itself as one failed "test" whose name is its path; it is not a counted test.
    if (d.nesting === 0 && d.name === d.file && ev.type === "test:fail") { counts[rel] ||= 0; continue; }
    // A failing test prints its own error at once (message, expected, actual, stack), capped at 60 lines: the spec reporter prints these only in its closing summary, which a file that never exits does not reach.
    if (ev.type === "test:fail") yield failureText(rel, d);
    counts[rel] = (counts[rel] || 0) + 1;
    if (d.skip || d.todo) (skipped[rel] ||= []).push(String(d.name));
  }
  const out = process.env.VYRE_TEST_COUNTS_OUT;
  if (out) fs.writeFileSync(out, JSON.stringify(counts, null, 1) + "\n");
  const skips = process.env.VYRE_TEST_SKIPS_OUT;
  if (skips) fs.writeFileSync(skips, JSON.stringify(skipped) + "\n");
  return;
  yield "";
}
