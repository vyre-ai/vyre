// The box role, recorder run "generated", part 1 of 6 (callers 0 mod 6; see cell.mjs).
import "../../scripts/mac-test-guard.mjs";
process.env.VYRE_GOLDEN_ROLE = "box";
process.env.VYRE_GOLDEN_RUN = "generated";
process.env.VYRE_GOLDEN_PART = "0/6";
await import("./cell.mjs");
