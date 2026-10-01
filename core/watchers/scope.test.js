import test from "node:test";
import assert from "node:assert/strict";
import { sees } from "./scope.js";

test("a person, a module and a hook see every project's watchers; an agent only its granted ones, and none when the grant is unknown", () => {
  assert.equal(sees({}, "harlow-legal"), true, "no reach: not an agent");
  assert.equal(sees({ reach: { all: true } }, "harlow-legal"), true);
  assert.equal(sees({ reach: { all: false, projects: ["harlow-legal"] } }, "harlow-legal"), true);
  assert.equal(sees({ reach: { all: false, projects: ["harlow-legal"] } }, "northwind"), false, "another project");
  assert.equal(sees({ reach: { all: false, projects: [] } }, "harlow-legal"), false, "an agent with no projects");
  assert.equal(sees({ reach: { all: false, projects: ["harlow-legal"] } }, null), false, "a watcher with no known project is not shown to a scoped agent");
});
