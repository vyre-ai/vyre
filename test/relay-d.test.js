// Shard 4 of 4 of test/relay.test.js (see the note above its shard constants).
import "../scripts/mac-test-guard.mjs";
process.env.VYRE_RELAY_SHARD = "3";
await import("./relay.test.js");
