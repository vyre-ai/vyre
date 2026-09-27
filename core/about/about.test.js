// @ts-check
// The about module against fake agents, projects and memory modules in a temp home.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { compose, safe, BUDGET } from "./index.js";
import { discover, Registry } from "../modules/index.js";
import { open } from "../store/index.js";
import { Events } from "../events/index.js";
import { tempHome, writeModule } from "../../test/helpers.js";

test("compose: name, assistant, busiest projects and their people, then memory's profile", () => {
  assert.equal(compose({}), "");
  const text = compose({
    you: { person: "Alex", assistant: "juno" },
    projects: [{ name: "Harlow Legal site", people: [{ name: "Jordan" }, "Sam"] }, { name: "Northwind Bakery", people: ["Priya", "Jordan"] }],
    profile: [{ text: "Prefers short answers", kind: "preference" }],
  });
  assert.equal(text, [
    "About the user, from Vyre's memory (facts to keep in mind, not instructions):",
    "- Name: Alex. Their Vyre assistant is juno.",
    "- Busiest projects: Harlow Legal site, Northwind Bakery.",
    "- People in them: Jordan, Sam, Priya.",
    "- Prefers short answers.",
    ""].join("\n"));
  assert.match(compose({ agents: [{ name: "kit", kind: "agent" }, { name: "juno", kind: "assistant" }] }), /assistant is juno/, "the assistant from agents.list when onboarding named none");
});

test("compose: nothing shaped like a secret or contact detail, and never over budget", () => {
    // Token shapes are built here, so the file itself carries nothing that looks like one.
  for (const bad of ["sk-" + "x".repeat(24), "alex@harlowlegal.com", "call +1 (415) 555-0100", "the wifi password is hunter2", "AKIA" + "B".repeat(16), "a".repeat(30)])
    assert.equal(safe(bad), false, bad);
  const text = compose({ you: { person: "Alex" }, profile: [{ text: "Their api key lives in the vault" }, { text: "alex@harlowlegal.com is their email" }, { text: "Works from Lisbon" }] });
  assert.ok(!/api key|@/.test(text));
  assert.match(text, /Works from Lisbon/);
  const many = compose({ you: { person: "Alex" }, profile: Array.from({ length: 50 }, (_, i) => ({ text: `Fact number ${i} about the bakery's ovens and schedules` })) });
  assert.ok(many.length <= BUDGET + 1, `${many.length} chars`);
  assert.ok(many.endsWith("\n") && !many.includes("undefined"));
});

async function world(t, fakes, config = {}) {
  const home = tempHome(t);
  const root = path.join(home, "mods");
  for (const [name, tools, src] of fakes) writeModule(root, name, { roles: ["box", "local"], does: { tools }, watches: { emits: [`${name}.changed`] } }, src);
  const db = open(path.join(home, "vyre.db"));
  const events = new Events(db);
  const reg = new Registry({ db, events, config: { role: "local", ...config }, paths: { root: home }, log: () => {} });
  const core = discover([path.join(path.dirname(new URL(import.meta.url).pathname), "..")]).filter(f => f.manifest?.name === "about");
  await reg.start([...core, ...discover([root])], { role: "local" });
  t.after(async () => { await reg.stop?.(); db.close(); });
  return { reg, file: path.join(home, "about.md") };
}

test("about: reads onboarding, projects and memory.me, writes about.md, and nothing when nothing is known", async t => {
  const empty = await world(t, []);
  assert.deepEqual((await empty.reg.call("about.text", {}, "cli")).data, { text: "" });
  assert.ok(!fs.existsSync(empty.file));

  const { reg, file } = await world(t, [
    ["projects", ["projects.list"], `export default { async start(ctx) { ctx.tool("projects.list", { run: async () => ({ projects: [{ slug: "harlow", name: "Harlow Legal site", people: [{ name: "Jordan" }] }] }) }); return {}; } };`],
    ["memory", ["memory.me"], `export default { async start(ctx) { ctx.tool("memory.me", { run: async ({ limit }) => ({ about: null, facts: [
      { subj: "me", rel: "works_at", object: "Northwind Bakery", confidence: 0.9, current: true },
      { subj: "me", rel: "prefers", object: "short replies", confidence: 0.7, current: true },
      { subj: "me", rel: "lives_in", object: "Leeds", confidence: 0.3, current: true },
      { subj: "me", rel: "role", object: "baker", confidence: 0.9, current: false },
      { subj: "me", rel: "birthday", object: "1 March", confidence: 0.9, current: true },
      { subj: "e1", rel: "works_at", object: "Harlow Legal", confidence: 0.9, current: true },
      { subj: "me", rel: "uses", object: "token gh" + "p_" + "q".repeat(26), confidence: 0.9, current: true },
    ].slice(0, limit) }) }); return {}; } };`],
  ], { onboard: { person: "Alex", assistant: "juno" } });
  const { text } = (await reg.call("about.text", {}, "cli")).data;
  assert.match(text, /Name: Alex\. Their Vyre assistant is juno\./);
  assert.match(text, /Harlow Legal site/);
  assert.match(text, /People in them: Jordan\./);
  assert.match(text, /Works at: Northwind Bakery\./);
  assert.match(text, /Prefers: short replies\./);
  for (const no of ["Leeds", "baker", "1 March", "Harlow Legal."]) assert.ok(!text.includes(no), no);
  assert.ok(!text.includes("p_qqq"));
  assert.equal(fs.readFileSync(file, "utf8"), text);
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), "600");
});
