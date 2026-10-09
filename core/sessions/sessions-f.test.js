// Shard 6 of 8 of core/sessions/sessions.test.js (see the note above its shard constants).
import "../../scripts/mac-test-guard.mjs";
process.env.VYRE_SESSIONS_SHARD = "5";
await import("./sessions.test.js");
