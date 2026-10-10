// @ts-check
// The list of an app's own domains (ingress v2): what counts as a domain, the limit, the records the person adds, and which address a signer is sent to.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { DOMAIN_MIGRATIONS, MAX_DOMAINS, cleanHost, createDomains, ownOrigin, recordsFor } from "./domains.js";

const fresh = () => { const db = new DatabaseSync(":memory:"); for (const m of DOMAIN_MIGRATIONS) db.exec(m); return createDomains(/** @type {any} */ (db), () => 1000); };

test("a domain is letters, digits and dashes in two labels or more, as typed with a scheme or a slash, and never an address, the zone or an xn-- spelling", () => {
  assert.equal(cleanHost("Sign.Firm.Example"), "sign.firm.example");
  assert.equal(cleanHost("https://sign.firm.example/some/path"), "sign.firm.example");
  assert.equal(cleanHost("sign.firm.example."), "sign.firm.example");
  for (const bad of ["", "nodot", "10.0.0.1", "a b.example", "vyre.run", "alex.vyre.run", "xn--bcher-kva.example", "-x.example", "x.e", null, 5]) assert.equal(cleanHost(bad), null, String(bad));
  assert.equal(cleanHost("alex.vyre.run", "other.zone"), "alex.vyre.run");
});

test("the list keeps a host once, moves it to another app, removes it, and stops at the limit", () => {
  const d = fresh();
  assert.equal(d.add("sign.firm.example", "documents"), true);
  assert.equal(d.add("sign.firm.example", "documents"), false, "the same again is nothing new");
  assert.equal(d.appOf("sign.firm.example"), "documents");
  assert.equal(d.appOf("other.firm.example"), null);
  assert.equal(d.add("sign.firm.example", "forms"), true);
  assert.equal(d.appOf("sign.firm.example"), "forms");
  assert.deepEqual(d.list(), [{ host: "sign.firm.example", app: "forms", created: 1000 }]);
  for (let i = 1; i < MAX_DOMAINS; i++) d.add(`h${i}.firm.example`, "documents");
  assert.throws(() => d.add("one-more.firm.example", "documents"), /at most/);
  assert.equal(d.add("h1.firm.example", "forms"), true, "moving an existing one is not a new domain");
  assert.equal(d.remove("h1.firm.example"), true);
  assert.equal(d.remove("h1.firm.example"), false);
});

test("the person adds the host's own CNAME and the challenge one; without the directory's answer only the first is known", () => {
  assert.deepEqual(recordsFor({ host: "sign.firm.example", name: "alex", acmeZone: "abc.acme.vyre.run" }), [
    { type: "CNAME", name: "sign.firm.example", value: "alex.vyre.run" },
    { type: "CNAME", name: "_acme-challenge.sign.firm.example", value: "abc.acme.vyre.run" },
  ]);
  assert.equal(recordsFor({ host: "sign.firm.example", name: "alex", acmeZone: null }).length, 1);
});

test("a signer is sent to the person's own domain only while the gate serves it, for the app it belongs to", () => {
  const list = [{ host: "sign.firm.example", app: "documents" }, { host: "forms.firm.example", app: "forms" }];
  assert.equal(ownOrigin(list, "documents", ["sign.firm.example"]), "https://sign.firm.example");
  assert.equal(ownOrigin(list, "documents", []), null, "not live yet: the Space's address stands");
  assert.equal(ownOrigin(list, "documents", ["forms.firm.example"]), null, "another app's domain");
  assert.equal(ownOrigin([], "documents", ["sign.firm.example"]), null);
});
