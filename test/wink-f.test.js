// Shard 6 of 6 of test/wink.test.js (see the note above its shard constants).
import "../scripts/mac-test-guard.mjs";
process.env.VYRE_WINK_SHARD = "5";
await import("./wink.test.js");
