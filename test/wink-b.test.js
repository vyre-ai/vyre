// Shard 2 of 6 of test/wink.test.js (see the note above its shard constants).
import "../scripts/mac-test-guard.mjs";
process.env.VYRE_WINK_SHARD = "1";
await import("./wink.test.js");
