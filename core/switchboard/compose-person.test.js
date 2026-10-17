// @ts-check
// A project reference in an AGENTS.md reads under the person the thread is for (roadmap 0.6 item 17): the Switchboard passes that person to the prompt composer, so a project the member may open is
// written with its address and one she cannot see stays a plain name; with no person at all (the owner's own terminal) nothing is asked.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Switchboard } from "./index.js";
import { withRefsResolved } from "../sessions/prompts.js";

const OWNER = "per_" + "o".repeat(26), ANA = "per_" + "a".repeat(26);
const OPEN = "[#Harlow estate](vyre://acme/project/harlow)", SHUT = "[#Northwind](vyre://acme/project/northwind)";

/** A Switchboard `this` with only what systemPrompt reads: the call port (work answers who may open a project), the verified asker of the turn, and the compose answer. */
function rig(/** @type {Map<string, string>} */ asker) {
  /** @type {any[]} */ const composed = [];
  const self = { turnAsker: asker, kindOf: () => "agent", deps: { log: () => {}, call: async (/** @type {string} */ tool, /** @type {any} */ i) => {
    if (tool === "work.project.may-read") return { data: { ok: i.person === ANA && i.project.endsWith("/harlow") } };
    if (tool === "sessions.prompt.compose") {
      composed.push(i);
      // what the composer does with the person it is given: each project reference is looked up for them
      const docs = await withRefsResolved({ project: { name: "p", text: `${OPEN} ${SHUT}` } }, async (r) => { if (!i.person) return false; const a = await self.deps.call("work.project.may-read", { project: r.urn, person: i.person }); return a.data.ok === true; });
      return { data: { text: docs && docs.project ? docs.project.text : "", mode: "append" } };
    }
    return { error: { code: "no_such_tool", message: tool } };
  } } };
  return { self, composed };
}
const systemPrompt = (/** @type {any} */ self, /** @type {any} */ rec, /** @type {any} */ o) => /** @type {any} */ (Switchboard.prototype).systemPrompt.call(self, rec, o);

test("the composer is given the thread's person: a project the member may open resolves with its address, one she cannot see stays a plain name", async () => {
  const { self, composed } = rig(new Map([["t1", ANA]]));
  const r = await systemPrompt(self, { id: "t1", project: "harlow", agent: "juno", provider: "claude", cwd: "/x" }, {});
  assert.equal(composed.length, 1);
  assert.equal(composed[0].person, ANA, "the verified asker of the turn");
  assert.equal(r.text, "#Harlow estate (project, vyre://acme/project/harlow) #Northwind", "the one she may open has its address, the other keeps only its name");
  assert.ok(!r.text.includes("northwind"), "no address of a project she cannot see");
});

test("a thread started for a member and resumed with no asker still resolves under her; with no person at all nothing resolves", async () => {
  const resumed = rig(new Map());
  const r = await systemPrompt(resumed.self, { id: "t2", project: "harlow", agent: "juno", provider: "claude", cwd: "/x" }, { person: ANA });
  assert.equal(resumed.composed[0].person, ANA, "the person the thread was started for");
  assert.match(r.text, /vyre:\/\/acme\/project\/harlow/);
  const terminal = rig(new Map());
  const t = await systemPrompt(terminal.self, { id: "t3", project: "harlow", agent: "juno", provider: "claude", cwd: "/x" }, {});
  assert.equal(terminal.composed[0] ? terminal.composed[0].person : undefined, undefined, "no person is passed");
  assert.equal(t.text, "#Harlow estate #Northwind", "plain names only");
  void OWNER;
});
