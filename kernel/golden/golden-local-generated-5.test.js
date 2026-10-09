// The local role, recorder run "generated", part 5 of 6 (callers 4 mod 6; see cell.mjs).
import "../../scripts/mac-test-guard.mjs";
process.env.VYRE_GOLDEN_ROLE = "local";
process.env.VYRE_GOLDEN_RUN = "generated";
process.env.VYRE_GOLDEN_PART = "4/6";
await import("./cell.mjs");
