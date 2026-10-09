// Shard 3 of 4 of core/cli/commands/connect.test.js (see the note above its shard constants).
import "../../../scripts/mac-test-guard.mjs";
process.env.VYRE_CONNECT_SHARD = "2";
await import("./connect.test.js");
