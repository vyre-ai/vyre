// Shard 2 of 4 of core/switchboard/switchboard.test.js (see the note above its shard constants).
import "../../scripts/mac-test-guard.mjs";
process.env.VYRE_SWITCHBOARD_SHARD = "1";
await import("./switchboard.test.js");
