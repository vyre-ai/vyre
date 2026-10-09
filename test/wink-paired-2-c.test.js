// Shard 3 of 3 of test/wink-paired-2.test.js (see the note above its shard constants).
import "../scripts/mac-test-guard.mjs";
process.env.VYRE_WINK_PAIRED2_SHARD = "2";
await import("./wink-paired-2.test.js");
