// The Mac test guard. The tests of this repo run on hosted runners and the test boxes, never on a person's Mac (RULES.md): some raise real dialogs, bind real ports or touch real files.
// Every *.test.js imports this file first (test/mac-test-guard.test.js fails on one that does not), so every way of running a test, `node --test <file>` included, stops here on macOS.
// Allowed on macOS: a hosted runner (GITHUB_ACTIONS), a test account (VYRE_TEST_HOSTED=1), or a run the lead has cleared for the Mac-only suites (VYRE_TEST_MAC_OK=1).
if (process.platform === "darwin" && process.env.GITHUB_ACTIONS !== "true" && process.env.VYRE_TEST_HOSTED !== "1" && process.env.VYRE_TEST_MAC_OK !== "1") {
  process.stderr.write("Tests do not run on this Mac. Run them on a hosted runner or the test box (set VYRE_TEST_MAC_OK=1 only when the lead has cleared a Mac-only suite).\n");
  process.exit(1);
}
