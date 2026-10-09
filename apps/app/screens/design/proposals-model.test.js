import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { byWords, decision, headline, usesLine } from "./proposals-model.js";

const screen = (before) => ({ id: 3, kind: "screen", screenId: "orders", title: "Orders", why: "x", by: "mcp:agent:engineer", status: "pending", before, after: {}, uses: { reads: ["orders.list"], runs: ["orders.close"] } });

test("design changes: each proposal says in one line what it changes and what the yes covers", () => {
  assert.equal(headline(screen(null)), "Adds a Orders screen".replace("a Orders", "a Orders"));
  assert.equal(headline(screen({})), "Changes the Orders screen");
  assert.equal(usesLine(screen(null)), "Reads orders.list. Its buttons run orders.close.");
  assert.equal(usesLine({ ...screen(null), uses: { reads: [], runs: [] } }), "Reads nothing of yours. It has no buttons that run anything.");
  const css = { ...screen("a"), kind: "css", screenId: "screen:orders" };
  assert.equal(headline(css), "Changes the styling of the orders screen");
  assert.equal(headline({ ...css, before: null, screenId: "space" }), "Adds styling to the whole space");
  assert.match(usesLine(css), /web app only/);
});

test("design changes: the tap sends the id and the answer, and who proposed it reads as a person would say it", () => {
  assert.deepEqual(decision(screen(null), true), { id: 3, yes: true });
  assert.equal(byWords("mcp:agent:engineer"), "The Engineer");
  assert.equal(byWords("mcp:agent:juno"), "juno");
  assert.equal(byWords("cli"), "You");
  assert.equal(byWords("mcp"), "An agent");
});
