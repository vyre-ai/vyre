// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { moveSecretsToGrants } from "./grants.js";
import { setup, person, model, automation, chainOf, DRAFT, SPACE } from "./test-kit.js";

const alex = person("per_alex"), kit = person("per_kit"), mara = person("per_mara"), sam = person("per_sam");

/** @param {ReturnType<typeof setup>} s @param {any} [draft] */
async function goLive(s, draft = DRAFT) {
  const d = await s.pub.create(alex, draft);
  await s.pub.preview(alex, d.id);
  const a = await s.pub.approve(alex, d.id);
  s.ask.decide(a.task, kit);
  await s.pub.approve(alex, d.id, { task: a.task });
  const p = await s.pub.publish(alex, d.id);
  s.ask.decide(p.task, alex);
  const live = await s.pub.publish(alex, d.id, { task: p.task });
  return { id: d.id, live };
}
const rejects = (/** @type {Promise<any>} */ p, /** @type {string} */ code) => assert.rejects(p, (/** @type {any} */ e) => e.name === "PublishError" && e.code === code, code);

test("the whole path: create, preview, approve, publish, with events carrying ids and urls only", async () => {
  const s = setup();
  const { id, live } = await goLive(s);
  assert.equal(live.deployment.stage, "Production");
  assert.equal(live.deployment.url, "https://northwind.harlow.vyre.run");
  assert.deepEqual(s.events.map(e => e.type), ["deployment.built", "deployment.previewed", "deployment.approved", "deployment.published"]);
  assert.ok(s.events.every(e => e.subject === `vyre://${SPACE.id}/deployment/${id}`));
  assert.ok(s.events.every(e => e.chain && !JSON.stringify(e.data).includes("secret")));
});

test("create validates the draft, versions per name, and authorizes", async () => {
  const s = setup();
  const a = await s.pub.create(alex, DRAFT), b = await s.pub.create(alex, DRAFT);
  assert.deepEqual([a.version, b.version], [1, 2]);
  assert.equal(a.stage, "Draft");
  await rejects(s.pub.create(alex, { ...DRAFT, build: { image: "ubuntu" } }), "bad_input");
  await rejects(s.pub.create(alex, { ...DRAFT, env: { API_KEY: "plain-value" } }), "bad_input");
  await rejects(s.pub.create(alex, { ...DRAFT, env: { VYRE_HOME: "vault://x/y" } }), "bad_input");
  const t = setup({ policy: { deny: ["deploy.create"] } });
  await rejects(t.pub.create(alex, DRAFT), "forbidden");
  await rejects(s.pub.create({ ...alex, space: "spc_otherabcdefg" }, DRAFT), "forbidden");
});

test("a model chain cannot approve a preview: only a person decides", async () => {
  const s = setup();
  const d = await s.pub.create(model(), DRAFT);
  await s.pub.preview(model(), d.id);
  const held = await s.pub.approve(model(), d.id); // a model may ask
  assert.equal(held.held, true);
  s.ask.decide(held.task, model());
  await rejects(s.pub.approve(alex, d.id, { task: held.task }), "model_cannot_approve");
  s.ask.decide(held.task, automation());
  await rejects(s.pub.approve(alex, d.id, { task: held.task }), "model_cannot_approve");
  assert.equal((await s.pub.status(alex, d.id)).stage, "Preview");
});

test("who may approve a preview: owner, admin, or the project's manager; not a member or another project's manager", async () => {
  const s = setup();
  const d = await s.pub.create(alex, DRAFT);
  await s.pub.preview(alex, d.id);
  const h = await s.pub.approve(alex, d.id);
  s.ask.decide(h.task, sam);
  await rejects(s.pub.approve(alex, d.id, { task: h.task }), "not_approver");
  s.ask.decide(h.task, person("per_pat"));
  await rejects(s.pub.approve(alex, d.id, { task: h.task }), "not_approver");
  s.ask.decide(h.task, person("per_ghost"));
  await rejects(s.pub.approve(alex, d.id, { task: h.task }), "not_approver");
  s.ask.decide(h.task, mara);
  const ok = await s.pub.approve(alex, d.id, { task: h.task });
  assert.equal(ok.deployment.stage, "Approved");
  assert.equal(ok.deployment.approved_by, "per_mara");
});

test("publishing without an approval fails, however it is asked", async () => {
  const s = setup();
  const d = await s.pub.create(alex, DRAFT);
  await rejects(s.pub.publish(alex, d.id), "illegal_transition"); // Draft
  await s.pub.preview(alex, d.id);
  await rejects(s.pub.publish(alex, d.id), "illegal_transition"); // Preview, not Approved
  const h = await s.pub.approve(alex, d.id);
  s.ask.decide(h.task, kit);
  await s.pub.approve(alex, d.id, { task: h.task });
  const p = await s.pub.publish(alex, d.id);
  assert.equal(p.held, true);
  await rejects(s.pub.publish(alex, d.id, { task: p.task }), "needs_approval"); // not decided
  await rejects(s.pub.publish(alex, d.id, { task: "task_nope" }), "approval_mismatch"); // never requested
  await rejects(s.pub.publish(alex, d.id, { task: h.task }), "approval_mismatch"); // the preview approval, replayed
  s.ask.decide(p.task, alex, "rejected");
  await rejects(s.pub.publish(alex, d.id, { task: p.task }), "needs_approval");
  s.ask.decide(p.task, model());
  await rejects(s.pub.publish(model(), d.id, { task: p.task }), "model_cannot_approve");
  assert.equal((await s.pub.status(alex, d.id)).stage, "Approved");
});

test("a member cannot publish; only an owner, an admin or the named approver", async () => {
  const s = setup();
  const d = await s.pub.create(alex, { ...DRAFT, approver: "per_pat" });
  await s.pub.preview(alex, d.id);
  const h = await s.pub.approve(alex, d.id); s.ask.decide(h.task, mara); await s.pub.approve(alex, d.id, { task: h.task });
  const p = await s.pub.publish(mara, d.id);
  s.ask.decide(p.task, mara);
  await rejects(s.pub.publish(mara, d.id, { task: p.task }), "not_approver");
  s.ask.decide(p.task, sam);
  await rejects(s.pub.publish(mara, d.id, { task: p.task }), "not_approver");
  s.ask.decide(p.task, person("per_pat")); // the named approver, a person in the space
  const live = await s.pub.publish(mara, d.id, { task: p.task });
  assert.equal(live.deployment.stage, "Production");
});

test("an approval is bound to what would change: a new domain after asking invalidates it", async () => {
  const s = setup();
  const d = await s.pub.create(alex, DRAFT);
  await s.pub.preview(alex, d.id);
  const h = await s.pub.approve(alex, d.id); s.ask.decide(h.task, kit); await s.pub.approve(alex, d.id, { task: h.task });
  const p = await s.pub.publish(alex, d.id);
  s.ask.decide(p.task, alex);
  const added = await s.pub.addDomain(alex, { host: "northwind.vyre.run", deployment: d.id });
  assert.equal(added.challenge.type, "names");
  await s.pub.verifyDomain(alex, "northwind.vyre.run");
  await rejects(s.pub.publish(alex, d.id, { task: p.task }), "approval_mismatch");
  const p2 = await s.pub.publish(alex, d.id);
  assert.deepEqual(p2.plan.urls, ["https://northwind.vyre.run"]);
});

test("plan: what goes public, where, with which secrets, replacing what", async () => {
  const s = setup();
  const first = await goLive(s);
  const d2 = await s.pub.create(alex, DRAFT);
  await s.pub.preview(alex, d2.id);
  const pv = await s.pub.plan(alex, d2.id);
  assert.equal(pv.action, "approve");
  assert.equal(pv.goes_public, false);
  const h = await s.pub.approve(alex, d2.id); s.ask.decide(h.task, kit); await s.pub.approve(alex, d2.id, { task: h.task });
  const pl = await s.pub.plan(alex, d2.id);
  assert.equal(pl.action, "publish");
  assert.equal(pl.goes_public, true);
  assert.deepEqual(pl.urls, ["https://northwind.harlow.vyre.run"]);
  assert.deepEqual(pl.replaces, { id: first.id, version: 1, url: "https://northwind.harlow.vyre.run" });
  assert.match(pl.hash, /^[0-9a-f]{64}$/);
  assert.deepEqual((await s.pub.plan(alex, d2.id)).hash, pl.hash);
});

test("publishing a new version retires the live one; rollback needs approval and restores it", async () => {
  const s = setup();
  const a = await goLive(s);
  const b = await goLive(s);
  assert.equal((await s.pub.status(alex, a.id)).stage, "Retired");
  const live = await s.pub.status(alex, b.id);
  assert.equal(live.stage, "Production");
  assert.equal(live.previous, a.id);
  // rollback is held; a model cannot decide; nothing changed until a person approves
  const r = await s.pub.rollback(model(), b.id);
  assert.equal(r.held, true);
  assert.equal(r.plan.action, "rollback");
  await rejects(s.pub.rollback(alex, b.id, { task: r.task }), "needs_approval");
  s.ask.decide(r.task, model());
  await rejects(s.pub.rollback(alex, b.id, { task: r.task }), "model_cannot_approve");
  assert.equal((await s.pub.status(alex, b.id)).stage, "Production");
  s.ask.decide(r.task, alex);
  const done = await s.pub.rollback(alex, b.id, { task: r.task });
  assert.equal(done.deployment.id, a.id);
  assert.equal((await s.pub.status(alex, a.id)).stage, "Production");
  assert.equal((await s.pub.status(alex, b.id)).stage, "Retired");
  assert.ok(s.events.some(e => e.type === "deployment.rolled_back" && e.data.id === a.id && e.data.from.id === b.id));
  await rejects(s.pub.rollback(alex, b.id), "not_production");
  const only = await goLive(setup());
  void only;
});

test("rollback with nothing to go back to is refused", async () => {
  const s = setup();
  const a = await goLive(s);
  await rejects(s.pub.rollback(alex, a.id), "no_previous");
});

test("retire takes a version down; a retired one cannot be previewed", async () => {
  const s = setup();
  const d = await s.pub.create(alex, DRAFT);
  const r = await s.pub.retire(alex, d.id);
  assert.equal(r.deployment.stage, "Retired");
  assert.equal(s.events.at(-1).type, "deployment.retired");
  await rejects(s.pub.preview(alex, d.id), "illegal_transition");
  await rejects(s.pub.retire(alex, d.id), "illegal_transition");
});

test("authorize is asked for every act with the caller's chain, and a deny stops it", async () => {
  const s = setup();
  const { id } = await goLive(s);
  const actions = new Set(s.authorize.calls.map(c => c.action));
  for (const a of ["deploy.create", "deploy.preview", "deploy.publish", "deploy.read"]) assert.ok(actions.has(a), a);
  assert.ok(s.authorize.calls.every(c => c.chain && c.resource.startsWith(`vyre://${SPACE.id}/`)));
  const t = setup({ policy: { deny: ["deploy.preview"] } });
  const d = await t.pub.create(alex, DRAFT);
  await rejects(t.pub.preview(alex, d.id), "forbidden");
  const u = setup({ policy: { deny: ["deploy.publish"] } });
  const e = await u.pub.create(alex, DRAFT);
  await u.pub.preview(alex, e.id);
  const h = await u.pub.approve(alex, e.id); u.ask.decide(h.task, kit); await u.pub.approve(alex, e.id, { task: h.task });
  await rejects(u.pub.publish(alex, e.id), "forbidden");
  void id;
});

test("a build with a sealed value is refused, in every normalised form, and no event is emitted", async () => {
  const forms = {
    exact: "ssn 123-45-6789 here",
    spaced: "ssn 123 45 6789",
    plain: "ssn 123456789",
    base64: "data " + Buffer.from("123-45-6789").toString("base64"),
    hex: "data " + Buffer.from("123-45-6789").toString("hex"),
    url: "q=123%2D45%2D6789",
  };
  for (const [name, text] of Object.entries(forms)) {
    const s = setup({ files: [{ path: "index.html", content: text }] });
    const d = await s.pub.create(alex, DRAFT);
    await rejects(s.pub.preview(alex, d.id), "sealed_in_build");
    assert.equal(s.events.length, 0, name);
    assert.equal((await s.pub.status(alex, d.id)).stage, "Draft", name);
  }
  const inLog = setup({ logs: "reading 123-45-6789 from the form" });
  const d = await inLog.pub.create(alex, DRAFT);
  await rejects(inLog.pub.preview(alex, d.id), "sealed_in_build");
});

test("build secrets: granted ones reach the build as --secret, are redacted from logs, and refuse a build that bakes them in", async () => {
  const s = setup({ logs: "using sk_live_FAKEFAKEFAKE1234 now" });
  const d = await s.pub.create(alex, DRAFT);
  const g = await s.pub.grantSecret(alex, d.id, { ref: "vault://harlow/stripe", name: "STRIPE_KEY", use: ["build"] });
  assert.equal(g.held, true);
  s.ask.decide(g.task, kit);
  await s.pub.grantSecret(alex, d.id, { ref: "vault://harlow/stripe", name: "STRIPE_KEY", use: ["build"], task: g.task });
  const p = await s.pub.preview(alex, d.id);
  assert.ok(!p.logs.includes("sk_live_FAKEFAKEFAKE1234"));
  assert.ok(p.logs.includes("[secret:STRIPE_KEY]"));
  assert.deepEqual(Object.keys(s.written), []); // cleaned up
  const t = setup({ files: [{ path: "app.js", content: "const k='sk_live_FAKEFAKEFAKE1234'" }] });
  const e = await t.pub.create(alex, DRAFT);
  const g2 = await t.pub.grantSecret(alex, e.id, { ref: "vault://harlow/stripe", name: "STRIPE_KEY", use: ["build"] });
  t.ask.decide(g2.task, alex);
  await t.pub.grantSecret(alex, e.id, { ref: "vault://harlow/stripe", name: "STRIPE_KEY", use: ["build"], task: g2.task });
  await rejects(t.pub.preview(alex, e.id), "secret_in_build");
});

test("a secret granted to deployment A is absent from B, in the record and in the generated edge", async () => {
  const s = setup();
  s.setBuild({ runtime: { kind: "node", image: "vyre-publish/app@sha256:" + "b".repeat(64), port: 3000 } });
  const a = await s.pub.create(alex, DRAFT);
  const g = await s.pub.grantSecret(alex, a.id, { ref: "vault://harlow/stripe", name: "STRIPE_KEY" });
  s.ask.decide(g.task, kit);
  await s.pub.grantSecret(alex, a.id, { ref: "vault://harlow/stripe", name: "STRIPE_KEY", task: g.task });
  const b = await s.pub.create(alex, DRAFT);
  assert.equal(b.secrets.length, 0);
  await s.pub.preview(alex, a.id); await s.pub.preview(alex, b.id);
  const { compose } = await s.pub.edge(alex);
  const sa = compose.services[`w-${a.id.slice(4)}`], sb = compose.services[`w-${b.id.slice(4)}`];
  assert.equal(sa.secrets.length, 1);
  assert.equal(sb.secrets, undefined);
  assert.ok(!JSON.stringify(sb).includes("STRIPE_KEY"));
  assert.ok(!JSON.stringify(compose).includes("sk_live"));
});

test("granting a real secret needs a person: the model's request waits, and a model's approval fails", async () => {
  const s = setup();
  const d = await s.pub.create(alex, DRAFT);
  const g = await s.pub.grantSecret(model(), d.id, { ref: "vault://harlow/stripe", name: "STRIPE_KEY" });
  assert.equal(g.held, true);
  s.ask.decide(g.task, model());
  await rejects(s.pub.grantSecret(alex, d.id, { ref: "vault://harlow/stripe", name: "STRIPE_KEY", task: g.task }), "model_cannot_approve");
  s.ask.decide(g.task, mara);
  await rejects(s.pub.grantSecret(alex, d.id, { ref: "vault://harlow/stripe", name: "STRIPE_KEY", task: g.task }), "not_approver");
  // a task for another secret cannot be reused
  s.ask.decide(g.task, alex);
  await rejects(s.pub.grantSecret(alex, d.id, { ref: "vault://harlow/stripe", name: "OTHER_KEY", task: g.task }), "approval_mismatch");
  const ok = await s.pub.grantSecret(alex, d.id, { ref: "vault://harlow/stripe", name: "STRIPE_KEY", task: g.task });
  assert.equal(ok.deployment.secrets[0].name, "STRIPE_KEY");
  assert.ok(!JSON.stringify(ok).includes("sk_live"));
  const st = await s.pub.status(alex, d.id);
  assert.deepEqual(st.secrets, [{ name: "STRIPE_KEY", class: "secret", use: ["runtime"] }]);
});

test("domains: a TXT challenge, verified by the resolver; only verified domains reach the Caddyfile", async () => {
  const s = setup();
  s.setBuild({ runtime: { kind: "static" } });
  const { id } = await goLive(s);
  const add = await s.pub.addDomain(alex, { host: "harlow-bakery.com", deployment: id });
  assert.equal(add.challenge.type, "TXT");
  assert.equal(add.challenge.name, "_vyre-publish.harlow-bakery.com");
  assert.match(add.challenge.value, /^vyre-publish=/);
  let e = await s.pub.edge(alex);
  assert.ok(!e.caddyfile.includes("harlow-bakery.com"));
  const miss = await s.pub.verifyDomain(alex, "harlow-bakery.com");
  assert.deepEqual([miss.verified, miss.reason], [false, "no_record"]);
  s.dnsTxt["_vyre-publish.harlow-bakery.com"] = [["vyre-publish=wrong"]];
  assert.equal((await s.pub.verifyDomain(alex, "harlow-bakery.com")).reason, "mismatch");
  s.dnsTxt["_vyre-publish.harlow-bakery.com"] = [["unrelated"], [add.challenge.value.slice(0, 20), add.challenge.value.slice(20)]];
  assert.equal((await s.pub.verifyDomain(alex, "harlow-bakery.com")).verified, true);
  e = await s.pub.edge(alex);
  assert.ok(e.caddyfile.includes("harlow-bakery.com {"));
  assert.ok(e.caddyfile.includes("www.harlow-bakery.com {"));
  assert.ok(!e.caddyfile.includes("on_demand"));
  const rm = await s.pub.removeDomain(alex, "harlow-bakery.com");
  assert.equal(rm.removed, "harlow-bakery.com");
  assert.ok(!(await s.pub.edge(alex)).caddyfile.includes("harlow-bakery.com"));
});

test("a domain moves to the next version of the same site on publish, without verifying again", async () => {
  const s = setup();
  s.setBuild({ runtime: { kind: "static" } });
  const a = await goLive(s);
  await s.pub.addDomain(alex, { host: "northwind.vyre.run", deployment: a.id });
  await s.pub.verifyDomain(alex, "northwind.vyre.run");
  const b = await goLive(s);
  const e = await s.pub.edge(alex);
  assert.ok(e.caddyfile.includes(`w-${b.id.slice(4)}:8080`));
  assert.ok(!e.caddyfile.includes(`w-${a.id.slice(4)}:8080`));
  assert.ok(e.caddyfile.includes("northwind.vyre.run {"));
});

test("the edge for what is live passes the isolation check", async () => {
  const s = setup();
  s.setBuild({ runtime: { kind: "node", image: "vyre-publish/app@sha256:" + "c".repeat(64), port: 3000 } });
  await goLive(s);
  const { compose } = await s.pub.edge(alex);
  assert.equal(compose.name, `vyre-publish-${SPACE.id}`);
  assert.ok(compose.services.caddy && compose.services.buildkit);
});

test("flow(id) returns the pipeline for the deployment", async () => {
  const s = setup();
  const d = await s.pub.create(alex, DRAFT);
  const f = await s.pub.flow(d.id);
  assert.deepEqual(f.steps.map((/** @type {any} */ x) => x.id), ["build", "preview", "approve", "production", "rollback"]);
});

test("one grant model: a granted secret is a kernel grant (vault.run on the credential, to the deployment's own service actor), and the record carries no secrets", async () => {
  const s = setup();
  const d = await s.pub.create(alex, DRAFT);
  const g = await s.pub.grantSecret(alex, d.id, { ref: "vault://harlow/stripe", name: "STRIPE_KEY", use: ["build", "runtime"] });
  s.ask.decide(g.task, kit);
  await s.pub.grantSecret(alex, d.id, { ref: "vault://harlow/stripe", name: "STRIPE_KEY", use: ["build", "runtime"], task: g.task });
  const [grant] = await s.mint.list("publish:secret:");
  assert.deepEqual(grant.actions, ["vault.run"]);
  assert.equal(grant.resource.prefix, `vyre://${SPACE.id}/credential/harlow/stripe`);
  assert.deepEqual(grant.subject.actor, { kind: "service", id: `deployment-${d.id}`, space: SPACE.id });
  assert.equal(grant.source, `publish:secret:${d.id}:STRIPE_KEY:secret:build+runtime`);
  assert.equal("secrets" in (await s.raw.get("deployments", d.id)), false, "the stored record has no secrets field");
  assert.deepEqual((await s.pub.status(alex, d.id)).secrets, [{ name: "STRIPE_KEY", class: "secret", use: ["build", "runtime"] }]);
  await s.pub.revokeSecret(alex, d.id, "STRIPE_KEY");
  assert.deepEqual(await s.mint.list("publish:secret:"), [], "taking it away ends the grant");
  assert.deepEqual((await s.pub.status(alex, d.id)).secrets, []);
});

test("one grant model: a deployment made before secrets were grants still builds with its secret; only the start-up move makes its grant (twice is the same as once)", async () => {
  const s = setup({ logs: "using sk_live_FAKEFAKEFAKE1234 now" });
  const d = await s.pub.create(alex, DRAFT);
  const old = await s.raw.get("deployments", d.id);
  await s.raw.put("deployments", d.id, { ...old, secrets: [{ name: "STRIPE_KEY", ref: "vault://harlow/stripe", class: "secret", use: ["build"], granted_by: "per_alex", granted_at: 1, resource: `vyre://${SPACE.id}/deployment/${d.id}` }] });
  assert.equal((await s.mint.list("publish:")).length, 0, "nothing is a grant yet");
  const p = await s.pub.preview(alex, d.id); // reads the old list, builds with the secret, writes the record
  assert.ok(p.logs.includes("[secret:STRIPE_KEY]"), "the build had the secret");
  assert.equal((await s.mint.list("publish:")).length, 0, "a build's write makes no grant: only the move does");
  assert.equal((await s.raw.get("deployments", d.id)).secrets.length, 1, "the old list is kept until the move");
  assert.equal(await moveSecretsToGrants(s.raw, s.store), 1);
  const [g] = await s.mint.list("publish:secret:");
  assert.equal(g.source, `publish:secret:${d.id}:STRIPE_KEY:secret:build`);
  assert.equal("secrets" in (await s.raw.get("deployments", d.id)), false);
  assert.equal(await moveSecretsToGrants(s.raw, s.store), 0);
  assert.equal((await s.mint.list("publish:secret:")).length, 1, "moving again makes no second grant");
});

test("one tap: a previewed version goes live on one decision that also approves the preview; the version it replaces is retired", async () => {
  const s = setup();
  const first = await goLive(s);
  const d = await s.pub.create(alex, DRAFT);
  await s.pub.preview(alex, d.id);
  const held = await s.pub.goLive(model(), d.id); // a model may ask
  assert.equal(held.held, true);
  assert.equal(held.plan.goes_public, true, "the plan the person says yes to is the public one");
  assert.equal(held.plan.replaces.id, first.id);
  await rejects(s.pub.goLive(alex, d.id, { task: held.task }), "needs_approval");
  s.ask.decide(held.task, model());
  await rejects(s.pub.goLive(alex, d.id, { task: held.task }), "model_cannot_approve");
  assert.equal((await s.pub.status(alex, d.id)).stage, "Preview", "nothing moved until a person said yes");
  s.ask.decide(held.task, alex);
  const done = await s.pub.goLive(alex, d.id, { task: held.task });
  assert.equal(done.deployment.stage, "Production");
  assert.equal(done.deployment.approved_by, "per_alex", "the same person's yes is the approval");
  assert.equal((await s.pub.status(alex, first.id)).stage, "Retired");
  assert.deepEqual(s.events.filter(e => e.data && e.data.id === d.id).map(e => e.type).slice(-2), ["deployment.approved", "deployment.published"]);
  await rejects(s.pub.goLive(alex, d.id, { task: held.task }), "illegal_transition"); // already live: the decision is spent
});

test("one tap: who may decide is the same as for publishing (a member is refused), and a changed plan voids the yes", async () => {
  const s = setup();
  const d = await s.pub.create(alex, DRAFT);
  await s.pub.preview(alex, d.id);
  const held = await s.pub.goLive(alex, d.id);
  s.ask.decide(held.task, sam);
  await rejects(s.pub.goLive(alex, d.id, { task: held.task }), "not_approver");
  assert.equal((await s.pub.status(alex, d.id)).stage, "Preview");
  const other = await s.pub.create(alex, { ...DRAFT, name: "other" });
  await s.pub.preview(alex, other.id);
  s.ask.decide(held.task, alex);
  await rejects(s.pub.goLive(alex, other.id, { task: held.task }), "approval_mismatch"); // a yes for one version is not a yes for another
  await rejects(s.pub.goLive(alex, (await s.pub.create(alex, { ...DRAFT, name: "draft-only" })).id), "illegal_transition"); // a draft has no preview to publish
});

test("the plan the person says yes to lists what would go public: how many files, how many bytes, and the first names", async () => {
  const s = setup();
  const d = await s.pub.create(alex, DRAFT);
  await s.pub.preview(alex, d.id);
  const { files } = await s.pub.plan(alex, d.id);
  assert.equal(files.count, 1);
  assert.ok(files.bytes > 0);
  assert.deepEqual(files.paths, ["index.html"]);
  const held = await s.pub.goLive(alex, d.id);
  assert.deepEqual(held.plan.files, files, "the same list on the one-tap plan");
});
