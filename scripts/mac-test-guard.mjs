// The Mac test guard. The tests of this repo run on hosted runners and the test boxes, never on a person's Mac (RULES.md): some raise real dialogs, bind real ports or touch real files.
// Every *.test.js imports this file first (test/mac-test-guard.test.js fails on one that does not), so a test started any way, `node --test <file>` included, stops here on macOS. The code under
// test carries the same refusal (lib/mac-test-refusal.js, imported by core/config and core/store), so a test file that lacks this line still stops when it loads Vyre.
// Allowed on macOS: a hosted runner (GITHUB_ACTIONS), a test account (VYRE_TEST_HOSTED=1), or a run the lead has cleared for the Mac-only suites (VYRE_TEST_MAC_OK=1).
import { REFUSAL, macWithoutLeave } from "../lib/mac-test-refusal.js";
if (macWithoutLeave()) {
  process.stderr.write(REFUSAL + "\n");
  process.exit(1);
}
