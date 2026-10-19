// @ts-check
// Findability (team/0.6/DESIGN-agent-prompt.md): the prompt is orientation, and the detail is looked up. For each topic an agent needs, a fixed question in plain words must bring the expected agent page into the
// first three results of docs.find, the way docs.find ranks them for an agent. A page that cannot be found by what an agent would ask is a page that does not exist.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadCorpus } from "../lib/docs-corpus.js";
import { buildIndex, search } from "../lib/docs-rank.js";
import { PKG_ROOT } from "../kernel/devbuild.js";

const HISTORY = /^(adr|design|releases|proposals)\//;
const c = loadCorpus(PKG_ROOT);
const index = buildIndex([...c.human, ...c.agent]);
const top = (/** @type {string} */ q) => search(index, q, { limit: 16, prefer: "agent", lift: 1.6, demote: HISTORY }).slice(0, 3).map(h => h.page.path);

/** @type {[string, string][]} */
const TOPICS = [
  ["use my own computer to open a browser", "agents/computers-and-files.md"],
  ["call a site's api without a connector", "agents/chrome-ops.md"],
  ["get a password without seeing it", "agents/sealed-and-secrets.md"],
  ["a field shows a sealed placeholder", "agents/sealed-and-secrets.md"],
  ["tell the person something or ask them to do something", "agents/notify.md"],
  ["I was woken for a task and need to hand it in", "agents/woken.md"],
  ["I was asked to review a task", "agents/woken.md"],
  ["work inside a project and stay in scope", "agents/projects.md"],
  ["read the history of a record before I change it", "agents/records.md"],
  ["remember something for later and search past sessions", "agents/sessions-and-context.md"],
];

test("each topic an agent needs is found by a plain question, in the first three results", () => {
  const missed = TOPICS.filter(([q, page]) => !top(q).includes(page)).map(([q, page]) => `${JSON.stringify(q)} should bring ${page}, brought ${top(q).join(", ")}`);
  assert.deepEqual(missed, []);
});
