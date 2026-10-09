// The box role, recorder run "gates" (see cell.mjs).
import "../../scripts/mac-test-guard.mjs";
process.env.VYRE_GOLDEN_ROLE = "box";
process.env.VYRE_GOLDEN_RUN = "gates";
await import("./cell.mjs");
