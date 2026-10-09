// Shard 2 of 2 of core/vault/module.test.js (see the note above its shard constants).
import "../../scripts/mac-test-guard.mjs";
process.env.VYRE_VAULT_MODULE_SHARD = "1";
await import("./module.test.js");
