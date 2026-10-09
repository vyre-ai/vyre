// Shard 4 of 4 of core/sessions/sessions.test.js (see the note above its shard constants).
import "../../scripts/mac-test-guard.mjs";
process.env.VYRE_SESSIONS_SHARD = "3";
await import("./sessions.test.js");
