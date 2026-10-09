// Shard 3 of 3 of test/wink-paired.test.js (see the note above its shard constants).
import "../scripts/mac-test-guard.mjs";
process.env.VYRE_WINK_PAIRED_SHARD = "2";
await import("./wink-paired.test.js");
