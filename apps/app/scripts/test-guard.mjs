// Imported first by every test file in apps/app. App tests never run on the user's Mac, not even the pure ones:
// they run on a test box (Linux, over ssh) or a hosted runner (VYRE_TEST_HOSTED=1, or GITHUB_ACTIONS set by GitHub).
// A person's own Mac is refused before any test code loads.
const hosted = process.env.VYRE_TEST_HOSTED === "1" || process.env.GITHUB_ACTIONS === "true";
if (process.platform === "darwin" && !hosted) {
  console.error("Refusing to run tests on a Mac that is not a hosted runner. Run them on a test box (ssh testbox3) or push the branch and let the hosted runners do it.");
  process.exit(1);
}
