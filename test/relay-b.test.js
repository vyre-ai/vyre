// Shard 2 of 4 of test/relay.test.js (see the note above its shard constants).
import "../scripts/mac-test-guard.mjs";
process.env.VYRE_RELAY_SHARD = "1";
await import("./relay.test.js");
