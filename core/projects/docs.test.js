// @ts-check
// A project's Instructions and Context: AGENTS.md at its root (CLAUDE.md a pointer at it) and context/ at its root. A person without a seat cannot read them, a viewer reads and cannot write, a contributor writes;
// every chat in the project gets the instructions in its brief. Real daemon, real kernel, temp home.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { boot } from "../team/team-fixture.js";

const BEN = "per_" + "c".repeat(26);
const ADA = "per_" + "d".repeat(26);

async function world(/** @type {any} */ t) {
  const { d, project } = await boot(t);
  const OWNER = d.kernel.id.owner;
  const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  const add = async (/** @type {string} */ p, /** @type {string} */ role, /** @type {number} */ n) => {
    await d.kernel.gateway.grants.setRole(ownerChain, { person: p, role }, { presence: { op: "x", fields: {}, n } });
    const chain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-" + p.slice(4, 8), person: p, path: "direct", session: "s-" + p.slice(4, 8) });
    return { token: (await d.kernel.surfaces.open(chain, {})).token };
  };
  const ben = await add(BEN, "member", 2);
  const ada = await add(ADA, "admin", 3);
  const as = (/** @type {any} */ who) => (/** @type {string} */ name, /** @type {any} */ input = {}) => d.registry.call(name, input, "deck", who);
  return { d, project, ben: as(ben), ada: as(ada), owner: (/** @type {string} */ n, /** @type {any} */ i = {}, /** @type {string} */ as = "cli") => d.registry.call(n, i, as) };
}

test("instructions and context: the owner and an admin write; CLAUDE.md is only a pointer and refuses writes; a member with no seat reads and writes nothing", { timeout: 120_000 }, async t => {
  const { ben, ada, owner, project } = await world(t);
  const w = await owner("projects.docs.set", { project: project.slug, file: "AGENTS.md", text: "Always draft, never send.\n" });
  assert.equal(w.error, undefined, JSON.stringify(w.error));
  assert.equal(fs.readFileSync(path.join(project.home, "CLAUDE.md"), "utf8"), "@AGENTS.md\n", "CLAUDE.md is exactly the pointer");
  const refused = await owner("projects.docs.set", { project: project.slug, file: "CLAUDE.md", text: "mine" });
  assert.match(refused.error.message, /Instructions live in AGENTS\.md/);
  assert.equal(fs.readFileSync(path.join(project.home, "AGENTS.md"), "utf8"), "Always draft, never send.\n", "a refused write changed nothing");
  // notes an older CLAUDE.md kept apart are appended once, under Notes, on the next write
  fs.writeFileSync(path.join(project.home, "CLAUDE.md"), "@AGENTS.md\n\nAsk before filing.\n");
  assert.match((await owner("projects.docs.get", { project: project.slug })).data.files["AGENTS.md"], /## Notes\n\nAsk before filing\./, "a person sees the notes before they are folded in");
  await owner("projects.docs.set", { project: project.slug, file: "AGENTS.md", text: "Always draft, never send.\n" });
  const merged = fs.readFileSync(path.join(project.home, "AGENTS.md"), "utf8");
  assert.equal(merged, "Always draft, never send.\n\n## Notes\n\nAsk before filing.\n");
  assert.equal(fs.readFileSync(path.join(project.home, "CLAUDE.md"), "utf8"), "@AGENTS.md\n");
  await owner("projects.docs.set", { project: project.slug, file: "AGENTS.md", text: merged });
  assert.equal(fs.readFileSync(path.join(project.home, "AGENTS.md"), "utf8"), merged, "the notes are appended once, never twice");
  assert.equal((await ada("projects.docs.get", { project: project.slug })).data.files["AGENTS.md"], "Always draft, never send.\n\n## Notes\n\nAsk before filing.\n", "an admin reads it");
  assert.equal((await ada("projects.refs.add", { project: project.slug, name: "Style", text: "Plain words." })).error, undefined);
  assert.equal((await ada("projects.refs.add", { project: project.slug, name: "Intake", files: "Clients/Rivera/intake.pdf" })).error, undefined);
  assert.deepEqual((await owner("projects.refs.list", { project: project.slug })).data.items.map((/** @type {any} */ i) => i.kind).sort(), ["link", "note"]);
  for (const [n, i] of [["projects.docs.get", {}], ["projects.docs.set", { file: "AGENTS.md", text: "x" }], ["projects.refs.list", {}], ["projects.refs.add", { name: "n", text: "x" }]]) {
    const r = await ben(/** @type {string} */ (n), { project: project.slug, ...i });
    assert.equal(r.error && r.error.code, "denied", `${n}: ${JSON.stringify(r).slice(0, 160)}`);
  }
});

test("a viewer reads the project's instructions and cannot write; a contributor writes", { timeout: 120_000 }, async t => {
  const { ben, ada, owner, project } = await world(t);
  await owner("projects.docs.set", { project: project.slug, file: "AGENTS.md", text: "Be exact.\n" });
  const seat = await ada("work.project.level", { project: project.slug, person: BEN, level: "viewer" });
  assert.equal(seat.error, undefined, JSON.stringify(seat.error));
  assert.equal((await ben("projects.docs.get", { project: project.slug })).data.files["AGENTS.md"], "Be exact.\n", "Can use reads");
  const no = await ben("projects.docs.set", { project: project.slug, file: "AGENTS.md", text: "Mine now." });
  assert.equal(no.error && no.error.code, "denied");
  assert.match(String(no.error.message), /read-only/);
  assert.equal((await ben("projects.refs.remove", { project: project.slug, name: "x" })).error.code, "denied");
  await ada("work.project.level", { project: project.slug, person: BEN, level: "contributor" });
  assert.equal((await ben("projects.docs.set", { project: project.slug, file: "AGENTS.md", text: "Be exact and kind.\n" })).error, undefined, "Can edit writes");
  assert.equal((await ben("projects.docs.set", { project: project.slug, file: "NOTES.md", text: "x" })).error.code, "bad_input");
});

test("a chat in the project is oriented to its instructions and context by path, with one line of what they say; a project with none names none", { timeout: 120_000 }, async t => {
  const { owner, project } = await world(t);
  const before = (await owner("projects.context", { project: project.slug })).data.text;
  assert.ok(!/AGENTS\.md/.test(before), "none yet: no instructions named");
  await owner("projects.docs.set", { project: project.slug, file: "AGENTS.md", text: "Never send an email without the lawyer's yes." });
  await owner("projects.refs.add", { project: project.slug, name: "Fee schedule", text: "Flat fees." });
  const text = (await owner("projects.context", { project: project.slug })).data.text;
  assert.match(text, /Vyre orientation/);
  assert.match(text, new RegExp(`${project.home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/AGENTS\\.md`), "the instructions by path");
  assert.match(text, /context\//, "the context folder by path");
  assert.match(text, /The instructions begin: "Never send an email without the lawyer's yes\."/, "one line, not the whole file");
  assert.ok(text.length < 3400);
});

test("an agent, a model or a guest caller is refused on every project instructions and context tool", { timeout: 120_000 }, async t => {
  const { owner, project } = await world(t);
  const tools = [["projects.docs.get", {}], ["projects.docs.set", { file: "AGENTS.md", text: "x" }], ["projects.refs.list", {}], ["projects.refs.add", { name: "n", text: "x" }], ["projects.refs.remove", { name: "n" }]];
  for (const as of ["mcp:agent:kit", "cli:agent:kit", "harness", "tailnet-guest"]) {
    for (const [name, input] of /** @type {[string, any][]} */ (tools)) {
      const r = await d_call(owner, name, { project: project.slug, ...input }, as);
      assert.ok(r.error, `${as} on ${name} ran: ${JSON.stringify(r).slice(0, 120)}`);
    }
  }
});
const d_call = (/** @type {any} */ owner, /** @type {string} */ n, /** @type {any} */ i, /** @type {string} */ as) => owner(n, i, as);

test("a link planted in a project's folder leaks nothing: not through projects.docs.get, not into the chat brief, not through a note written", { timeout: 120_000 }, async t => {
  const { owner, project } = await world(t);
  const outside = fs.mkdtempSync(path.join(path.dirname(project.home), "outside-"));
  fs.writeFileSync(path.join(outside, "secret.txt"), "TOP SECRET");
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(project.home, "AGENTS.md"));
  const got = await owner("projects.docs.get", { project: project.slug });
  assert.equal(got.data.files["AGENTS.md"], "", JSON.stringify(got.data));
  const brief = (await owner("projects.context", { project: project.slug })).data.text;
  assert.ok(!/TOP SECRET/.test(brief), "the brief carries no secret");
  fs.symlinkSync(outside, path.join(project.home, "context"));
  const add = await owner("projects.refs.add", { project: project.slug, name: "planted", text: "x" });
  assert.ok(add.error, "a linked context folder refuses the write");
  assert.equal(fs.existsSync(path.join(outside, "planted.md")), false);
  assert.deepEqual((await owner("projects.refs.list", { project: project.slug })).data.items, []);
  fs.rmSync(outside, { recursive: true, force: true });
});
