// The Mac test refusal, for the code under test. Tests of this repo run on hosted runners and the test boxes, never on a person's Mac (RULES.md). scripts/mac-test-guard.mjs stops a test FILE that
// imports it first; this module is imported by the code those tests load (core/config, core/store), so a test file that lacks the guard line, however the run was started (`node --test <file>`, an
// editor, a script), still stops the moment it touches Vyre's own code. It acts only under the node test runner (NODE_TEST_CONTEXT), so a daemon, a CLI or an app never sees it.
// What it cannot cover: a test file that imports none of Vyre's code and lacks the guard line (a pure unit test of a script); the hygiene test (test/mac-test-guard.test.js) keeps those few honest.
export const REFUSAL = "Tests do not run on this Mac. Run them on the test boxes (ssh testbox, see team/RULES.md) or a hosted runner. Only the lead sets VYRE_TEST_MAC_OK=1, for a cleared Mac-only suite.";

/** Is this a Mac that is not a hosted runner, a test account or a run the lead cleared? @param {Record<string, string | undefined>} [env] @param {string} [platform] */
export const macWithoutLeave = (env = process.env, platform = process.platform) =>
  platform === "darwin" && env.GITHUB_ACTIONS !== "true" && env.VYRE_TEST_HOSTED !== "1" && env.VYRE_TEST_MAC_OK !== "1";

if (process.env.NODE_TEST_CONTEXT && macWithoutLeave()) {
  process.stderr.write(REFUSAL + "\n");
  process.exit(1);
}
