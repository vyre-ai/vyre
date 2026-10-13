// @ts-check
// An agent's sharing: anyone creates one and owns it; Can use and Can edit are given to a person or a role; a link is judged against the person adding it. Real daemon, real kernel, temp home.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { boot } from "../team/team-fixture.js";

const BEN = "per_" + "c".repeat(26);
const ADA = "per_" + "d".repeat(26);

async function world(/** @type {any} */ t) {
  const { tool, d, project } = await boot(t);
  const OWNER = d.kernel.id.owner;
  const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  /** @param {string} p @param {string} role @param {number} n */
  const add = async (p, role, n) => {
    await d.kernel.gateway.grants.setRole(ownerChain, { person: p, role }, { presence: { op: "x", fields: {}, n } });
    const chain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-" + p.slice(4, 8), person: p, path: "direct", session: "s-" + p.slice(4, 8) });
    return { token: (await d.kernel.surfaces.open(chain, {})).token };
  };
  const ben = await add(BEN, "member", 2);
  const ada = await add(ADA, "admin", 3);
  const as = (/** @type {any} */ who) => (/** @type {string} */ name, /** @type {any} */ input = {}) => d.registry.call(name, input, "deck", who);
  return { tool, d, project, ben: as(ben), ada: as(ada), owner: (/** @type {string} */ n, /** @type {any} */ i = {}) => d.registry.call(n, i, "cli") };
}

test("a member makes an agent and owns it; a member with no access sees nothing of another's agent", { timeout: 120_000 }, async t => {
  const { ben, owner } = await world(t);
  const made = await ben("agents.create", { name: "mine", kind: "agent", projects: [] });
  assert.equal(made.error, undefined, JSON.stringify(made.error));
  assert.equal((await ben("agents.docs.set", { agent: "mine", file: "CLAUDE.md", text: "hi" })).error, undefined, "the creator edits her own");
  await owner("agents.create", { name: "intake", kind: "agent", projects: [], instructions: "secret words" });
  for (const [n, i] of [["agents.docs.get", { agent: "intake" }], ["agents.docs.set", { agent: "intake", file: "CLAUDE.md", text: "x" }], ["agents.context.list", { agent: "intake" }], ["agents.used", { agent: "intake" }], ["agents.access.get", { agent: "intake" }]]) {
    const r = await ben(/** @type {string} */ (n), i);
    assert.equal(r.error && r.error.code, "denied", `${n}: ${JSON.stringify(r).slice(0, 140)}`);
  }
});

test("Can use sees where an agent is used and nothing more; Can edit changes its files; neither shares it", { timeout: 120_000 }, async t => {
  const { ben, owner } = await world(t);
  await owner("agents.create", { name: "intake", kind: "agent", projects: [], instructions: "words" });
  assert.equal((await owner("agents.access.set", { agent: "intake", kind: "person", subject: BEN, level: "use" })).error, undefined);
  assert.equal((await ben("agents.used", { agent: "intake" })).error, undefined, "Can use sees where it is used");
  assert.equal((await ben("agents.docs.get", { agent: "intake" })).error.code, "denied", "but not its instructions");
  assert.equal((await ben("agents.docs.set", { agent: "intake", file: "CLAUDE.md", text: "x" })).error.code, "denied");
  assert.equal((await ben("agents.vault.assign", { agent: "intake", item: "mail" })).error.code, "denied");
  assert.equal((await owner("agents.access.set", { agent: "intake", kind: "person", subject: BEN, level: "edit" })).error, undefined);
  assert.equal((await ben("agents.docs.get", { agent: "intake" })).data.files["AGENTS.md"], "words");
  assert.equal((await ben("agents.docs.set", { agent: "intake", file: "CLAUDE.md", text: "kind" })).error, undefined, "Can edit changes it");
  assert.equal((await ben("agents.context.add", { agent: "intake", name: "a.txt", base64: "QQ==" })).error, undefined);
  assert.equal((await ben("agents.access.set", { agent: "intake", kind: "person", subject: ADA, level: "edit" })).error.code, "denied", "an editor does not share it further");
  await owner("agents.access.set", { agent: "intake", kind: "person", subject: BEN, level: null });
  assert.equal((await ben("agents.docs.get", { agent: "intake" })).error.code, "denied", "taking it away takes it away");
});

test("access by role reaches everyone in the role", { timeout: 120_000 }, async t => {
  const { ben, owner } = await world(t);
  await owner("agents.create", { name: "intake", kind: "agent", projects: [] });
  const sh = await owner("agents.access.set", { agent: "intake", kind: "role", subject: "member", level: "use" });
  assert.equal(sh.error, undefined);
  assert.equal((await ben("agents.used", { agent: "intake" })).error, undefined);
  assert.equal((await ben("agents.docs.set", { agent: "intake", file: "CLAUDE.md", text: "x" })).error.code, "denied");
});

test("a link is judged against the person adding it: a member cannot link a folder she cannot reach; the admin who made it links his own", { timeout: 120_000 }, async t => {
  const { ben, ada, owner, project } = await world(t);
  const home = project.home;
  fs.mkdirSync(`${home}/forms`, { recursive: true });
  const mk = await ada("agents.create", { name: "intake", kind: "agent", projects: [project.slug] });
  assert.equal(mk.error, undefined, JSON.stringify(mk.error));
  await ada("agents.access.set", { agent: "intake", kind: "person", subject: BEN, level: "edit" });
  const refused = await ben("agents.context.link", { agent: "intake", path: `${home}/forms` });
  assert.equal(refused.error && refused.error.code, "denied", JSON.stringify(refused));
  assert.match(String(refused.error.message), /cannot read the project|cannot see that folder/);
  const ok = await ada("agents.context.link", { agent: "intake", path: `${home}/forms` });
  assert.equal(ok.error, undefined, JSON.stringify(ok));
  assert.deepEqual((await owner("agents.context.list", { agent: "intake" })).data.links.length, 1);
});
