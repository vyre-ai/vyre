// Not a test of the suite (the runner skips fixtures): a file whose cases pass and whose process then ends with an error, as a daemon's crash handler does.
import { test } from "node:test";
test("a case that passes", () => {});
setTimeout(() => { process.stderr.write("fatal: the daemon crashed after the cases: ECONNRESET\n"); process.exit(1); }, 50);
