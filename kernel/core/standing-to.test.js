// @ts-check
// The `to` condition of a standing permission: every recipient must match an address, a *@domain or a list; none, or one outside it, matches nothing.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { toAllows, plainAddress, patternCovers } from "./authorize.js";

test("toAllows: addresses, *@domain and lists; every recipient must match; no recipient matches nothing", async () => {
  const to = { patterns: ["dana@harlowlegal.com", "*@northwind-bakery.example"], lists: ["project:p1:clients"] };
  const listHas = async (/** @type {string} */ list, /** @type {string} */ a) => list === "project:p1:clients" && a === "pat@client.example";
  assert.equal(await toAllows(to, ["Dana@HarlowLegal.com"], listHas), true, "an address, any case");
  assert.equal(await toAllows(to, ["orders@northwind-bakery.example"], listHas), true, "*@domain");
  assert.equal(await toAllows(to, ["pat@client.example"], listHas), true, "a list member");
  assert.equal(await toAllows(to, ["dana@harlowlegal.com", "x@elsewhere.com"], listHas), false, "one outside is enough to refuse");
  assert.equal(await toAllows(to, ["x@evil-northwind-bakery.example"], listHas), false, "a domain suffix is not a match");
  assert.equal(await toAllows(to, ["a@sub.northwind-bakery.example"], listHas), false, "nor is a subdomain");
  assert.equal(await toAllows(to, [], listHas), false, "no recipients: nothing is covered");
  assert.equal(await toAllows(undefined, ["dana@harlowlegal.com"], listHas), false);
  assert.equal(await toAllows({ lists: ["project:p1:clients"] }, ["pat@client.example"], async () => { throw new Error("gone"); }), false, "a list that cannot be read matches nothing");
  assert.equal(await toAllows({ patterns: ["*@x.example"] }, ["a@x.example"], undefined), true);
});

test("the standing action is named-only: no wildcard grant covers it", () => {
  assert.equal(patternCovers("*", "gate.act-standing", 0, 1, "write"), null);
  assert.equal(patternCovers("gate.*", "gate.act-standing", 0, 1, "write"), null);
  assert.equal(patternCovers("gate.act-standing", "gate.act-standing", 0, 1, "write"), "covered");
});

test("an address is one plain address: a second @, a list, a display name or a bracket never matches, and a pattern compares the whole domain, case-folded", async () => {
  const to = { patterns: ["*@example.com", "dana@harlowlegal.com"] };
  for (const bad of ["attacker@evil.com@example.com", "a@example.com, b@evil.com", "a@example.com;b@evil.com", "Dana <dana@harlowlegal.com>", "<dana@harlowlegal.com>", "dana@harlowlegal.com ", "a b@example.com", "\"a\"@example.com", "@example.com", "a@"]) {
    assert.equal(await toAllows(to, [bad], undefined), bad === "dana@harlowlegal.com " ? true : false, JSON.stringify(bad));
  }
  assert.equal(await toAllows(to, ["A@EXAMPLE.COM"], undefined), true, "the domain is case-folded");
  assert.equal(await toAllows(to, ["a@notexample.com"], undefined), false, "a longer domain is not the domain");
  assert.equal(plainAddress("Lee@Harlow.Example"), "lee@harlow.example");
  assert.equal(plainAddress("lee@@x"), null);
});
