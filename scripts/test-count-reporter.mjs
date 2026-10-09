// A node:test reporter that counts, per test file, the tests that really ran (passed, failed, skipped or todo; suites and the file itself are not tests).
// It writes JSON { "<repo-relative file>": N } to the path in VYRE_TEST_COUNTS_OUT when the run ends. scripts/test-counts.mjs compares that with test/test-counts.json.
import fs from "node:fs";
import path from "node:path";

/** @param {AsyncIterable<{ type: string, data: any }>} source */
export default async function* countReporter(source) {
  /** @type {Record<string, number>} */ const counts = {};
  const root = process.cwd();
  for await (const ev of source) {
    if (ev.type !== "test:pass" && ev.type !== "test:fail") continue;
    const d = ev.data;
    if (!d.file || d.details?.type === "suite") continue;
    // A shard file (sessions-b.test.js imports sessions.test.js) registers its tests in the file it imports: the runner names the file it started in VYRE_TEST_COUNTS_FILE, so each shard is counted, and guarded, on its own.
    const rel = process.env.VYRE_TEST_COUNTS_FILE ? process.env.VYRE_TEST_COUNTS_FILE : path.relative(root, d.file).split(path.sep).join("/");
    // A file that crashed or was cancelled reports itself as one failed "test" whose name is its path; it is not a counted test.
    if (d.nesting === 0 && d.name === d.file && ev.type === "test:fail") { counts[rel] ||= 0; continue; }
    counts[rel] = (counts[rel] || 0) + 1;
  }
  const out = process.env.VYRE_TEST_COUNTS_OUT;
  if (out) fs.writeFileSync(out, JSON.stringify(counts, null, 1) + "\n");
  return;
  yield "";
}
