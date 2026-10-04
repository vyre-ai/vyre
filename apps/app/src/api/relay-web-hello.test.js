import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = f => fs.readFileSync(path.join(SRC, f), "utf8");

// The web pairing hello carried NO device key for a day: relay.web.ts imported b64url from "../auth/person", which Metro resolves to person.web.ts on the web (it exports none), so
// presenceKey() threw and every hello went without a key. A Node test cannot run Metro, so it pins the two facts the bug needed.
test("the web hello always carries the device key: presenceKey() imports its encoder from the file that has it, and pairing passes the key to the relay client", () => {
  const web = read("api/relay.web.ts");
  assert.match(web, /import \{ b64url \} from "\.\.\/auth\/person\.ts"/, "b64url comes from person.ts by its full name, not from the platform-resolved ../auth/person");
  assert.doesNotMatch(web, /import \{[^}]*b64url[^}]*\} from "\.\.\/auth\/person";/, "no platform-resolved import of b64url");
  const webPerson = read("auth/person.web.ts");
  assert.doesNotMatch(webPerson, /export (async )?function b64url|export const b64url/, "person.web.ts has no b64url (so a platform-resolved import would be undefined)");
  assert.match(read("auth/person.ts"), /export function b64url/, "person.ts has it");
  const pairing = read("real/pairing.ts");
  assert.match(pairing, /presenceKey: await presenceKey\(\)/, "pairing offers the key in the hello");
  assert.match(web, /export async function presenceKey/);
});
