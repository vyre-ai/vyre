// The local role, recorder run "plain" (see cell.mjs).
import "../../scripts/mac-test-guard.mjs";
process.env.VYRE_GOLDEN_ROLE = "local";
process.env.VYRE_GOLDEN_RUN = "plain";
await import("./cell.mjs");
