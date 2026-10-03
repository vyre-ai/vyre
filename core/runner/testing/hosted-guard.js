// The runner's tests start sandboxes, mount encrypted images, open sockets and probe the system. They never run on a person's own Mac:
// on macOS they run only on a hosted runner (or a test account), which sets VYRE_TEST_HOSTED=1. Imported first by every runner test and
// by scripts/runner-perf.mjs. (Rule from the lead, 4 Oct, after two accidental runs.)
if (process.platform === "darwin" && process.env.VYRE_TEST_HOSTED !== "1") {
  throw new Error("runner and sandbox tests do not run on a Mac unless VYRE_TEST_HOSTED=1 is set by a hosted runner or a test account");
}
