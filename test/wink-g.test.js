// The slow case of test/wink.test.js, alone (see the note above its shard constants).
import "../scripts/mac-test-guard.mjs";
process.env.VYRE_WINK_SHARD = "slow";
await import("./wink.test.js");
