// @ts-check
// "Mint an id for a record" is lib/id.js (a time-ordered uuid, `prefix_<uuid>`), consolidation inventory item 11. Secrets, tickets, nonces and passwords are NOT ids: they must be random with no time in
// them, and stay `randomBytes`. This test fails when a source file mints a record id (`prefix_` + random bytes) or defines its own `newId` instead of calling lib/id.js.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { findInSource } from "./source-files.js";
import { newPrefixedId, isUuid, timeOf } from "../lib/id.js";

const ALLOWED = new Map([
  ["lib/id.js", "the one place"],
  ["kernel/core/ids.js", "the one minting file"],
  ["core/planner/legacy-fixture/", "frozen copy of the 0.2.3 store (a migration fixture)"],
  ["core/spaces/index.js", "mints `spc_` Space ids, which keep their own fixed format (SPACE_ID, kernel/spaces) and are never rewritten"],
  ["kernel/grants/index.js", "an invite's id is the capability the invitee presents: it must be full-width random, with no time in it"],
  ["kernel/seal/leases.js", "inside the sealing process, which imports nothing from lib/ (its wire format keeps the 24-hex lease id)"],
  ["kernel/seal/testing.js", "test support: a fake signer"],
  ["core/term/index.js", "a terminal id names a dtach socket file, and a unix socket path has a length limit a 36-character uuid would break"],
  ["core/team/index.js", "a short code a person reads and types (`r_ab12cd34`)"],
  ["lib/spaces/move-pull.js", "a pull ticket is a bearer: full-width random, with no time in it"],
  ["lib/connectors/testing/", "test support: a fake OAuth server's codes and tokens"],
]);
const PATTERNS = [
  /`\w+_\$\{(?:crypto\.)?randomBytes\(/,
  /["']\w+_["']\s*\+\s*(?:crypto\.)?randomBytes\(/,
  /(?:const|function)\s+newId\b[^\n]*randomBytes/,
];

test("no other source file mints a record id of its own", () => {
  assert.deepEqual(findInSource(PATTERNS, ALLOWED), [], "call newPrefixedId(prefix) from lib/id.js; a secret or a nonce is not an id and may stay random bytes");
});

test("a minted id is prefix + a time-ordered uuid", () => {
  const a = newPrefixedId("a"), b = newPrefixedId("a");
  assert.match(a, /^a_[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  assert.ok(isUuid(a.slice(2)) && timeOf(a) !== null && a !== b);
});
