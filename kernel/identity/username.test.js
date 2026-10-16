// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { personUrl, legacyRedirect, publicCard, checkUsername } from "./username.js";

test("the person address is vyre.run/u/<name>, and the old host redirects", () => {
  assert.equal(personUrl("alex"), "https://vyre.run/u/alex");
  assert.deepEqual(legacyRedirect("alex.vyre.run"), { status: 301, location: "https://vyre.run/u/alex" });
  assert.equal(legacyRedirect("app.vyre.run"), null);
  assert.equal(legacyRedirect("relay.vyre.run"), null);
  assert.equal(legacyRedirect("names.vyre.run"), null);
  assert.equal(publicCard({ name: "alex", id: "per_abc", discoverable: false }).private, true);
  assert.equal(publicCard({ name: "alex", id: "per_abc", discoverable: false }).id, undefined);
  assert.equal(publicCard({ name: "alex", id: "per_abc", discoverable: true, github: { login: "alex-studio" } }).url, "https://vyre.run/u/alex");
  assert.throws(() => checkUsername("api"), (e) => e.code === "bad_input");
});
