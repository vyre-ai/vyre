// @ts-check
// Who makes and publishes a template (rc1-d review of the templates work): over a small in-memory kernel, no server. A new template is the owner's or an admin's, also through an assistant of one; an assistant of a MEMBER makes none
// (its chain's first hop is the member), and a draft is put live only by an owner or an admin, so a member cannot publish one by routing define through an assistant and then going live herself.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createTemplates } from "./templates.js";

const SPACE = "spc_x", ADMIN = "per_admin", ANA = "per_ana", ROLES = /** @type {Record<string, string>} */ ({ [ADMIN]: "owner", [ANA]: "member" });
const BODY = (/** @type {string} */ name) => ({ name, stages: [{ name: "Start", tasks: [{ title: "Do it", doer: "role:owner", output: { kind: "note" } }] }, { name: "Done" }] });
const chain = (/** @type {string} */ person, agent = false) => ({ hops: [{ actor: { kind: "person", id: person, space: SPACE } }, ...(agent ? [{ actor: { kind: "agent", id: "kit", space: SPACE } }] : [])] });

function world() {
  /** @type {any[]} */ const rows = [];
  const kernel = {
    space: SPACE,
    members: { roleOf: (/** @type {any} */ a) => ROLES[a.id] || null },
    serviceChain: () => ({ hops: [] }),
    records: {
      query: async (/** @type {any} */ _c, /** @type {string} */ _t, /** @type {any} */ q) => ({ rows: rows.filter((r) => !q.filter || r.data[q.filter.field] === q.filter.value) }),
      create: async (/** @type {any} */ _c, /** @type {string} */ _t, /** @type {any} */ data) => { const r = { id: `r${rows.length}`, urn: `vyre://x/t/r${rows.length}`, version: 1, data }; rows.push(r); return r; },
      update: async (/** @type {any} */ _c, /** @type {string} */ _t, /** @type {string} */ id, /** @type {any} */ patch) => { const r = rows.find((x) => x.id === id); Object.assign(r.data, patch); return r; },
    },
  };
  return createTemplates({ kernel: () => kernel, hub: () => ({}), flows: () => null });
}

test("an assistant of a member makes no new template; an assistant of an admin does", async () => {
  const t = world();
  await assert.rejects(t.define(chain(ANA, true), { body: BODY("Hers") }), /owner or an admin makes a new template/);
  await assert.rejects(t.define(chain(ANA), { body: BODY("Hers") }), /owner or an admin makes a new template/);
  assert.equal((await t.define(chain(ADMIN, true), { body: BODY("Theirs") })).state, "draft");
});

test("a draft is put live only by an owner or an admin, even a draft the member owns", async () => {
  const t = world();
  const made = await t.define(chain(ADMIN), { body: BODY("Kit") });
  await assert.rejects(t.goLive(chain(ANA), { template: made.template, version: 1 }), /owner or an admin puts/);
  assert.equal((await t.goLive(chain(ADMIN), { template: made.template, version: 1 })).state, "live");
});

test("a new version of someone else's template is added by its owner or an admin, not by an assistant of a member", async () => {
  const t = world();
  const made = await t.define(chain(ADMIN), { body: BODY("Kit") });
  await assert.rejects(t.define(chain(ANA, true), { template: made.template, body: BODY("Kit") }), /owner or an admin adds a version/);
  assert.equal((await t.define(chain(ADMIN, true), { template: made.template, body: BODY("Kit") })).version, 2);
});

test("a template a member owns (made before this rule) still lists", async () => {
  const t = world();
  const made = await t.define(chain(ADMIN), { body: BODY("Old") });
  await t.goLive(chain(ADMIN), { template: made.template, version: 1 });
  const row = (await t.list(chain(ANA))).templates.find((/** @type {any} */ x) => x.template === made.template);
  assert.equal(row.live, 1);
});

test("a draft is saved in place with replace: the same version, the new body; a live version is never rewritten", async () => {
  const t = world();
  const made = await t.define(chain(ADMIN), { body: BODY("Draft one") });
  const again = await t.define(chain(ADMIN), { template: made.template, body: { ...BODY("Draft one"), description: "second" }, replace: true });
  assert.equal(again.version, 1, "no new version: autosave does not pile them up");
  assert.equal((await t.get(chain(ADMIN), { template: made.template, version: 1 })).body.description, "second");
  assert.equal((await t.list(chain(ADMIN), { template: made.template })).versions.length, 1);
  await t.goLive(chain(ADMIN), { template: made.template, version: 1 });
  const next = await t.define(chain(ADMIN), { template: made.template, body: { ...BODY("Draft one"), description: "third" }, replace: true });
  assert.equal(next.version, 2, "the newest is live, so a replace makes a new draft instead");
  assert.equal((await t.get(chain(ADMIN), { template: made.template, version: 1 })).body.description, "second", "the live version is untouched");
});

test("replace is the owner's or an admin's, like any change to a template", async () => {
  const t = world();
  const made = await t.define(chain(ADMIN), { body: BODY("Draft two") });
  await assert.rejects(t.define(chain(ANA), { template: made.template, body: BODY("Draft two"), replace: true }), /owner or an admin/);
});

test("the Kit library lists each template's outline (stage names and task titles) beside its counts, so a screen can start from a Kit's tasks without installing it", () => {
  const lib = world().library();
  assert.ok(lib.length > 0, "the shipped Kits have project templates");
  for (const e of lib) {
    assert.equal(e.outline.length, e.stages, `${e.id}: one outline entry per stage`);
    assert.equal(e.outline.reduce((n, s) => n + s.tasks.length, 0), e.tasks, `${e.id}: the task titles add up to its task count`);
    assert.ok(e.outline.every((s) => typeof s.name === "string" && s.tasks.every((t) => typeof t === "string")));
  }
});
