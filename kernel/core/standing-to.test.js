// @ts-check
// The `to` condition of a standing permission: every recipient must match an address, a *@domain or a list; none, or one outside it, matches nothing.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { toAllows, patternCovers } from "./authorize.js";

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
