// Shard 4 of 5 of core/names/backup.test.js (see the note above its shard constants).
import "../../scripts/mac-test-guard.mjs";
process.env.VYRE_BACKUP_SHARD = "3";
await import("./backup.test.js");
