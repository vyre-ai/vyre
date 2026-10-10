// The local role, recorder run "gates" (see cell.mjs).
import "../../scripts/mac-test-guard.mjs";
process.env.VYRE_GOLDEN_ROLE = "local";
process.env.VYRE_GOLDEN_RUN = "gates";
await import("./cell.mjs");
