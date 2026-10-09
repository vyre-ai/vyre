// Shard 2 of 2 of test/relay.test.js (see the note above its shard constants).
import "../scripts/mac-test-guard.mjs";
process.env.VYRE_RELAY_SHARD = "1";
await import("./relay.test.js");
