// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { listingLine, personOfServer, readOnlyEntries, readOnlyIdentity } from "./account-read.js";

test("Account says in plain words when a Space's address could not be put on its server, and nothing when all is well", () => {
  assert.equal(listingLine(""), "");
  assert.equal(listingLine(null), "");
  const line = listingLine("tess.vyre.run: the names directory could not be reached");
  assert.match(line, /^Your Space's address is not live yet/);
  assert.match(line, /tess\.vyre\.run: the names directory could not be reached/);
  assert.match(line, /Press Retry/);
  assert.doesNotMatch(line, /\u2014|vyre [a-z]+ /, "no dash and no command");
});

/** @param {Record<string, any>} answers */
const fake = (answers) => { /** @type {string[]} */ const seen = []; const call = async (/** @type {string} */ tool, /** @type {any} */ input) => { seen.push(`${tool} ${JSON.stringify(input ?? {})}`); const a = answers[tool]; return a instanceof Error ? { error: { code: "x", message: a.message } } : { data: a }; }; return { call, seen }; };

test("a server that knows its person says who, marked read-only, with the display name when it has one", async () => {
  const { call } = fake({ "onboard.status": { person: "tess", accountName: "Tess Hale" } });
  assert.deepEqual(await readOnlyIdentity(call, { exists: false }), { exists: true, name: "tess", label: "Tess Hale", readOnly: true });
  assert.deepEqual(await personOfServer(fake({ "onboard.status": { person: " tess " } }).call), { username: "tess", label: "tess" });
});

test("a server that knows no one keeps the box's own answer; a server that cannot answer does too", async () => {
  assert.deepEqual(await readOnlyIdentity(fake({ "onboard.status": { person: null } }).call, { exists: false }), { exists: false });
  assert.deepEqual(await readOnlyIdentity(fake({ "onboard.status": new Error("no") }).call, { exists: false }), { exists: false });
});

test("the list is read from the directory by the id the server resolves for the name, and is empty when there is none", async () => {
  const { call, seen } = fake({ "onboard.status": { person: "tess" }, "spaces.identity.resolve": { id: "per_abc" } });
  const read = async (/** @type {string} */ id) => [{ eid: `e-${id}`, kind: "device" }];
  assert.deepEqual(await readOnlyEntries(call, read), [{ eid: "e-per_abc", kind: "device" }]);
  assert.ok(seen.includes('spaces.identity.resolve {"name":"tess"}'));
  assert.deepEqual(await readOnlyEntries(fake({ "onboard.status": { person: "tess" }, "spaces.identity.resolve": {} }).call, read), []);
  assert.deepEqual(await readOnlyEntries(fake({ "onboard.status": {} }).call, read), []);
});
