// The Vault as an .env you can share safely (env-model.js): pasted lines become items grouped by prefix, each field plain or secret by the vault's own detector, values byte-exact
// with a quiet warning, names in one form and unique ignoring case, Copy as .env reads back the same bytes.
import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fieldProblems, itemCall, liveName, moveField, pasteDrafts, placeholder, searchItems, secretHint, toDotenv, valueWarning, withoutEnds } from "./env-model.js";
import { envEntries } from "../../../../lib/env-lines.js";

const ENV = [
  "# the sales sub-account",
  "GHL_API_KEY=pit-7f2a91c4-5b6d-4e8f-a1b2-c3d4e5f6a7b8",
  "GHL_LOCATION_ID=Jx81QnZt2LmPa94Kd0Rw",
  "TWILIO_ACCOUNT_SID=AC" + "0123456789abcdef".repeat(2),
  "TWILIO_AUTH_TOKEN=" + "f00dbabe".repeat(4),
  "TWILIO_FROM_NUMBER=+14155550140",
  "RESEND_API_KEY=re_" + "Ab3dE6gH9jK2mN5pQ8sT",
  "PORT=3000",
].join("\n");

test("pasted lines become one item per prefix: GHL_API_KEY and GHL_LOCATION_ID are one item", () => {
  const { drafts, skipped } = pasteDrafts(ENV);
  assert.deepEqual(skipped, []);
  assert.deepEqual(drafts.map((d) => [d.name, d.fields.map((f) => f.key)]), [
    ["GHL", ["GHL_API_KEY", "GHL_LOCATION_ID"]],
    ["Twilio", ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"]],
    ["Resend", ["RESEND_API_KEY"]],
    ["Other settings", ["PORT"]],
  ]);
});

test("ids, numbers and addresses are guessed plain; keys and tokens secret", () => {
  const all = Object.fromEntries(pasteDrafts(ENV).drafts.flatMap((d) => d.fields).map((f) => [f.key, f.secret]));
  assert.equal(all.GHL_API_KEY, true);
  assert.equal(all.GHL_LOCATION_ID, false, "an _ID is plain");
  assert.equal(all.TWILIO_ACCOUNT_SID, false, "an account SID is plain");
  assert.equal(all.TWILIO_AUTH_TOKEN, true);
  assert.equal(all.TWILIO_FROM_NUMBER, false);
  assert.equal(all.RESEND_API_KEY, true);
  assert.equal(all.PORT, false);
});

test("a pasted value is kept byte-exact; a space or a new line at an end is only warned about", () => {
  const { drafts } = pasteDrafts("GHL_API_KEY=pit-1234 \nGHL_LOCATION_ID= loc9\n");
  const [key, loc] = drafts[0].fields;
  assert.equal(key.value, "pit-1234 ", "never trimmed");
  assert.equal(loc.value, " loc9");
  assert.equal(valueWarning(key.value), "This value ends with a space.");
  assert.equal(valueWarning(loc.value), "This value starts with a space.");
  assert.equal(valueWarning("abc\n"), "This value ends with a new line.");
  assert.equal(valueWarning("a b"), null, "a space inside is the value's own");
  assert.equal(withoutEnds(" a b \n"), "a b", "Remove it takes the ends only");
  const call = itemCall({ name: "GHL Sales", fields: [key, loc] });
  assert.ok(!("error" in call));
  assert.deepEqual(call.input.fields, { GHL_API_KEY: "pit-1234 ", GHL_LOCATION_ID: " loc9" }, "the save sends exactly what was pasted");
});

test("an item saves as an env-set: names in one form, the plain ones named, a member's to her own vault", () => {
  const d = { name: "GHL Sales", fields: [
    { id: "1", key: "ghl api-key", value: "k", secret: true, on: true },
    { id: "2", key: "Ghl_Location_Id", value: "loc", secret: false, on: true },
    { id: "3", key: "unwanted", value: "x", secret: true, on: false },
  ] };
  assert.deepEqual(itemCall(d), { tool: "vault.put", input: { name: "GHL-Sales", kind: "env-set", fields: { GHL_API_KEY: "k", GHL_LOCATION_ID: "loc" } }, plain: ["GHL_LOCATION_ID"] }, "the plain fields are the item's rule, saved by vault.use.set");
  assert.deepEqual(itemCall(d, { member: true }), { tool: "vault.me.put", input: { name: "GHL-Sales", kind: "env-set", fields: { GHL_API_KEY: "k", GHL_LOCATION_ID: "loc" } }, plain: [] });
  assert.deepEqual(itemCall({ name: "", fields: d.fields }), { error: "Give the item a name." });
});

test("names are unique ignoring case and punctuation: adding api_key beside API_KEY says so", () => {
  const p = fieldProblems([{ id: "a", key: "API_KEY", value: "1" }, { id: "b", key: "api_key", value: "2" }, { id: "c", key: "!!", value: "3" }]);
  assert.equal(p.b, "This item already has API_KEY.");
  assert.equal(p.c, "Give the field a name, like API_KEY.");
  assert.equal(p.a, undefined);
  assert.equal(liveName("ghl api"), "GHL_API", "shown in its one form as it is typed");
  assert.equal(liveName("ghl "), "GHL_", "a separator just typed waits for the next word");
});

test("a field can be moved to another item or a new one, and an emptied item goes", () => {
  const { drafts } = pasteDrafts(ENV);
  const port = drafts[3].fields[0].id;
  const moved = moveField(drafts, port, drafts[0].id);
  assert.deepEqual(moved.map((d) => d.name), ["GHL", "Twilio", "Resend"]);
  assert.ok(moved[0].fields.some((f) => f.key === "PORT"));
  const apart = moveField(drafts, drafts[1].fields[2].id, "new");
  assert.equal(apart.length, 5);
});

test("search matches an item's fields; Copy as .env reads back byte-exact; a secret is checked by its length and last four", () => {
  const items = [{ id: "GHL-Sales", name: "GHL Sales", fields: [{ name: "GHL_API_KEY", plain: false }, { name: "ghl_location_id", plain: true }] }];
  assert.equal(searchItems(items, "LOCATION_ID").length, 1, "an older lower-case field is found by its one form");
  const env = toDotenv([{ name: "GHL_API_KEY", value: "pit-1234 " }, { name: "ghl location id", value: "two\nlines" }]);
  assert.deepEqual(Object.fromEntries(envEntries(env, { exact: true }).entries.map((e) => [e.key, e.value])), { GHL_API_KEY: "pit-1234 ", GHL_LOCATION_ID: "two\nlines" });
  assert.equal(secretHint("pit-7f2a91c4-5b6d-a7b8"), "22 characters, ends in a7b8");
  assert.equal(secretHint("short"), "5 characters", "a short secret shows no characters");
  assert.equal(placeholder("GHL-Sales", "ghl_api_key"), "{{vault:GHL-Sales.GHL_API_KEY}}");
});
