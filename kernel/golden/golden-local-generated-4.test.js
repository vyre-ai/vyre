// The local role, recorder run "generated", part 4 of 6 (callers 3 mod 6; see cell.mjs).
import "../../scripts/mac-test-guard.mjs";
process.env.VYRE_GOLDEN_ROLE = "local";
process.env.VYRE_GOLDEN_RUN = "generated";
process.env.VYRE_GOLDEN_PART = "3/6";
await import("./cell.mjs");
