// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { deploymentType, transition, rollback, TRANSITIONS, STAGES, ACTIONS, EVENT_TYPES, normalizeDraft, BUILD_IMAGES } from "./deployment.js";
import { person, model, SPACE, ROLES } from "./test-kit.js";
import { FIELD_KINDS, RISKS } from "../../kernel/contracts/index.js";

const roles = { roleOf: (/** @type {string} */ id) => /** @type {any} */ (ROLES)[id] || null, managesProject: (/** @type {string} */ id, /** @type {string} */ p) => id === "per_mara" && p === "bakery" };
const urn = (/** @type {string} */ id) => `vyre://${SPACE.id}/deployment/${id}`;
const base = (/** @type {any} */ over = {}) => ({ id: "dep_0123456789abcdef", space: SPACE.id, name: "northwind", version: 1, stage: "Draft", source: { kind: "repo", ref: "r" }, build: { image: "static" }, project: "bakery", approver: null, ...over });
const allow = (/** @type {string} */ action, /** @type {string} */ id = "dep_0123456789abcdef", effect = "allow") => ({ effect, reason: "ok", decision: "dec_1", action, resource: urn(id) });
const approval = (/** @type {any} */ by, hash = "h1") => ({ task: "t", outcome: "approved", by, payload_hash: hash });
const throwsCode = (/** @type {() => any} */ fn, /** @type {string} */ code) => assert.throws(fn, (/** @type {any} */ e) => e.code === code, code);
const build = { digest: "sha256:" + "a".repeat(64), sealed_checked: true };

test("the record type is a language definition in the contract's shape", () => {
  assert.equal(deploymentType.name, "deployment");
  assert.ok(deploymentType.fields.every(f => FIELD_KINDS.includes(f.kind) && f.name && f.label));
  assert.deepEqual(deploymentType.stages?.map(s => s.name), [...STAGES]);
  const names = deploymentType.fields.map(f => f.name);
  for (const n of ["name", "source_kind", "source_ref", "build_command", "build_output", "build_image", "env", "url", "previous", "created_by", "stage"]) assert.ok(names.includes(n), n);
  assert.deepEqual(deploymentType.fields.find(f => f.name === "build_image")?.options, [...BUILD_IMAGES]);
  assert.equal(deploymentType.fields.find(f => f.name === "previous")?.to, "deployment");
  assert.ok(Object.isFrozen(deploymentType) && Object.isFrozen(deploymentType.fields));
});

test("actions carry the risks the spec names", () => {
  assert.equal(ACTIONS["deploy.preview"].risk, "write");
  assert.equal(ACTIONS["deploy.publish"].risk, "outward.publish");
  assert.equal(ACTIONS["deploy.rollback"].risk, "outward.publish");
  assert.ok(Object.values(ACTIONS).every(a => RISKS.includes(a.risk) && a.action.split(".").length === 2 && a.label && a.gloss));
  assert.deepEqual(EVENT_TYPES.length, 6);
});

test("every legal transition, and every other pair is refused", () => {
  const legal = new Set(TRANSITIONS.map(t => `${t.from}>${t.to}`));
  for (const from of STAGES) for (const to of STAGES) {
    if (legal.has(`${from}>${to}`)) continue;
    throwsCode(() => transition(base({ stage: from }), to, { chain: person("per_alex"), now: 1 }), "illegal_transition");
  }
  assert.ok(legal.has("Draft>Preview") && legal.has("Preview>Approved") && legal.has("Approved>Production") && legal.has("Production>Retired") && legal.has("Retired>Production"));
});

test("Draft to Preview needs deploy.preview, a checked build, and emits built and previewed", () => {
  const ctx = { chain: person("per_alex"), now: 5, build, url: "https://abc.preview.harlow.vyre.run" };
  throwsCode(() => transition(base(), "Preview", ctx), "forbidden");
  throwsCode(() => transition(base(), "Preview", { ...ctx, authz: { ...allow("deploy.preview"), effect: "deny" } }), "forbidden");
  throwsCode(() => transition(base(), "Preview", { ...ctx, authz: { ...allow("deploy.preview"), effect: "ask" } }), "needs_approval");
  throwsCode(() => transition(base(), "Preview", { ...ctx, authz: allow("deploy.publish") }), "forbidden");
  throwsCode(() => transition(base(), "Preview", { ...ctx, authz: allow("deploy.preview", "dep_ffffffffffffffff") }), "forbidden");
  throwsCode(() => transition(base(), "Preview", { ...ctx, authz: allow("deploy.preview"), build: { ...build, sealed_checked: false } }), "sealed_in_build");
  throwsCode(() => transition(base(), "Preview", { ...ctx, authz: allow("deploy.preview"), build: { digest: "latest", sealed_checked: true } }), "bad_input");
  const r = transition(base(), "Preview", { ...ctx, authz: allow("deploy.preview") });
  assert.equal(r.deployment.stage, "Preview");
  assert.equal(r.deployment.build_digest, build.digest);
  assert.deepEqual(r.events.map(e => e.type), ["deployment.built", "deployment.previewed"]);
  assert.equal(r.events[0].subject, urn("dep_0123456789abcdef"));
  assert.equal(base().stage, "Draft"); // never mutates
});

test("Preview to Approved: a person with the role; a model never", () => {
  const d = base({ stage: "Preview", build_digest: build.digest, url: "https://abc.preview.harlow.vyre.run" });
  const go = (/** @type {any} */ by, /** @type {any} */ extra = {}) => transition(d, "Approved", { chain: person("per_alex"), now: 9, roles, payload_hash: "h1", approval: approval(by), ...extra });
  assert.equal(go(person("per_alex")).deployment.stage, "Approved");
  assert.equal(go(person("per_kit")).deployment.approved_by, "per_kit");
  assert.equal(go(person("per_mara")).deployment.approved_by, "per_mara");
  throwsCode(() => go(person("per_pat")), "not_approver");
  throwsCode(() => go(person("per_sam")), "not_approver");
  throwsCode(() => go(person("per_ghost")), "not_approver");
  throwsCode(() => go(model()), "model_cannot_approve");
  throwsCode(() => go({ ...person("per_alex"), hops: [{ actor: { kind: "service", id: "publish", space: SPACE.id } }] }), "model_cannot_approve");
  throwsCode(() => go(person("per_alex"), { approval: undefined }), "needs_approval");
  throwsCode(() => go(person("per_alex"), { approval: { ...approval(person("per_alex")), outcome: "rejected" } }), "needs_approval");
  const noProject = transition({ ...d, project: null }, "Approved", { chain: person("per_alex"), now: 1, roles, approval: approval(person("per_alex")) });
  assert.equal(noProject.deployment.stage, "Approved");
  throwsCode(() => transition({ ...d, project: null }, "Approved", { chain: person("per_alex"), now: 1, roles, approval: approval(person("per_mara")) }), "not_approver");
  assert.equal(go(person("per_alex")).events[0].type, "deployment.approved");
});

test("Approved to Production: deploy.publish AND a person's approval bound to the plan; held, never allow alone", () => {
  const d = base({ stage: "Approved", approved_by: "per_kit", build_digest: build.digest });
  const ctx = { chain: person("per_alex"), now: 9, roles, payload_hash: "h1", url: "https://northwind.harlow.vyre.run", authz: allow("deploy.publish", d.id, "ask"), approval: approval(person("per_alex")) };
  const ok = transition(d, "Production", ctx);
  assert.equal(ok.deployment.stage, "Production");
  assert.equal(ok.deployment.url, ctx.url);
  assert.equal(ok.events[0].type, "deployment.published");
  throwsCode(() => transition(d, "Production", { ...ctx, authz: undefined }), "forbidden");
  throwsCode(() => transition(d, "Production", { ...ctx, authz: { ...ctx.authz, effect: "deny" } }), "forbidden");
  throwsCode(() => transition(d, "Production", { ...ctx, approval: undefined }), "needs_approval");
  throwsCode(() => transition(d, "Production", { ...ctx, authz: allow("deploy.publish", d.id, "allow"), approval: undefined }), "needs_approval");
  throwsCode(() => transition(d, "Production", { ...ctx, approval: approval(model()) }), "model_cannot_approve");
  throwsCode(() => transition(d, "Production", { ...ctx, approval: approval(person("per_mara")) }), "not_approver");
  throwsCode(() => transition(d, "Production", { ...ctx, approval: approval(person("per_alex"), "other") }), "approval_mismatch");
  throwsCode(() => transition(d, "Production", { ...ctx, payload_hash: undefined }), "approval_mismatch");
  throwsCode(() => transition(d, "Production", { ...ctx, url: "http://x" }), "bad_input");
  throwsCode(() => transition({ ...d, approved_by: undefined }, "Production", ctx), "needs_approval");
  assert.equal(transition({ ...d, approver: "per_mara" }, "Production", { ...ctx, approval: approval(person("per_mara")) }).deployment.published_by, "per_mara");
});

test("publishing over the live version links previous and retires it", () => {
  const live = base({ id: "dep_aaaaaaaaaaaaaaaa", stage: "Production", version: 1, url: "https://northwind.harlow.vyre.run" });
  const d = base({ stage: "Approved", version: 2, approved_by: "per_kit", build_digest: build.digest });
  const r = transition(d, "Production", { chain: person("per_alex"), now: 3, roles, payload_hash: "h1", url: "https://northwind.harlow.vyre.run", authz: allow("deploy.publish", d.id, "ask"), approval: approval(person("per_alex")), replaces: live });
  assert.equal(r.deployment.previous, live.id);
  assert.equal(r.retired.stage, "Retired");
  assert.deepEqual(r.events.map(e => e.type), ["deployment.published", "deployment.retired"]);
  throwsCode(() => transition(d, "Production", { chain: person("per_alex"), now: 3, roles, payload_hash: "h1", url: "https://x.example.com", authz: allow("deploy.publish", d.id, "ask"), approval: approval(person("per_alex")), replaces: { ...live, name: "other" } }), "bad_input");
});

test("Production to Retired needs deploy.retire; discard from earlier stages too", () => {
  throwsCode(() => transition(base({ stage: "Production" }), "Retired", { chain: person("per_alex"), now: 1 }), "forbidden");
  const r = transition(base({ stage: "Production" }), "Retired", { chain: person("per_alex"), now: 1, authz: allow("deploy.retire") });
  assert.deepEqual(r.events.map(e => e.type), ["deployment.retired"]);
  for (const stage of ["Draft", "Preview", "Approved"]) assert.equal(transition(base({ stage }), "Retired", { chain: person("per_alex"), now: 1, authz: allow("deploy.retire") }).deployment.stage, "Retired");
});

test("a retired deployment cannot be revived with transition(); only rollback restores", () => {
  throwsCode(() => transition(base({ stage: "Retired" }), "Production", { chain: person("per_alex"), now: 1, authz: allow("deploy.rollback") }), "illegal_transition");
});

test("rollback: needs deploy.rollback and a person's approval; restores the previous and retires the current", () => {
  const prev = base({ id: "dep_aaaaaaaaaaaaaaaa", stage: "Retired", version: 1, published_at: 1, retired_at: 2, build_digest: build.digest, url: "https://northwind.harlow.vyre.run" });
  const cur = base({ id: "dep_bbbbbbbbbbbbbbbb", stage: "Production", version: 2, previous: prev.id, url: "https://northwind.harlow.vyre.run" });
  const ctx = { chain: person("per_alex"), now: 10, roles, payload_hash: "h1", authz: allow("deploy.rollback", prev.id, "ask"), approval: approval(person("per_kit")) };
  const r = rollback(cur, prev, ctx);
  assert.equal(r.restored.stage, "Production");
  assert.equal(r.restored.retired_at, undefined);
  assert.equal(r.current.stage, "Retired");
  assert.deepEqual(r.events.map(e => e.type), ["deployment.rolled_back", "deployment.retired"]);
  assert.equal(r.events[0].data.from.id, cur.id);
  throwsCode(() => rollback(cur, prev, { ...ctx, approval: undefined }), "needs_approval");
  throwsCode(() => rollback(cur, prev, { ...ctx, approval: approval(model()) }), "model_cannot_approve");
  throwsCode(() => rollback(cur, prev, { ...ctx, authz: allow("deploy.publish", prev.id, "ask") }), "forbidden");
  throwsCode(() => rollback(cur, prev, { ...ctx, authz: undefined }), "forbidden");
  throwsCode(() => rollback(cur, prev, { ...ctx, payload_hash: "nope" }), "approval_mismatch");
  throwsCode(() => rollback({ ...cur, stage: "Approved" }, prev, ctx), "not_production");
  throwsCode(() => rollback({ ...cur, previous: null }, prev, ctx), "no_previous");
  throwsCode(() => rollback(cur, { ...prev, published_at: undefined }, ctx), "no_previous");
  throwsCode(() => rollback(cur, { ...prev, stage: "Draft" }, ctx), "no_previous");
});

test("events carry ids, versions and urls, never env values or secrets", () => {
  const d = base({ stage: "Production", env: { API_KEY: "vault://x/y" }, secrets: [{ name: "API_KEY", ref: "vault://x/y" }], url: "https://northwind.harlow.vyre.run" });
  const r = transition(d, "Retired", { chain: person("per_alex"), now: 1, authz: allow("deploy.retire") });
  const text = JSON.stringify(r.events);
  assert.ok(!text.includes("vault://") && !text.includes("API_KEY"));
  assert.deepEqual(Object.keys(r.events[0].data).sort(), ["id", "name", "url", "version"]);
});

test("normalizeDraft: the fixed image list, one-line commands, relative output, secret references only", () => {
  const ok = normalizeDraft({ name: "northwind", source: { kind: "drive", ref: "folder123" } });
  assert.equal(ok.build.image, "static");
  for (const bad of [
    { name: "North Wind", source: { kind: "repo", ref: "r" } },
    { name: "a", source: { kind: "ftp", ref: "r" } },
    { name: "a", source: { kind: "repo", ref: "r" }, build: { image: "debian" } },
    { name: "a", source: { kind: "repo", ref: "r" }, build: { command: "npm i\nrm -rf /" } },
    { name: "a", source: { kind: "repo", ref: "r" }, build: { output_dir: "../x" } },
    { name: "a", source: { kind: "repo", ref: "r" }, build: { output_dir: "/etc" } },
    { name: "a", source: { kind: "repo", ref: "r" }, env: { SESSION: "abc" } },
    { name: "a", source: { kind: "repo", ref: "r" }, env: { lower: "vault://a/b" } },
    { name: "a", source: { kind: "repo", ref: "r" }, env: { DATABASE_URL: "vault://a/b" } },
  ]) throwsCode(() => normalizeDraft(bad), "bad_input");
});

test("a deployment description is strict: a setting it does not define refuses it (egress, ports, a stray build key)", () => {
  const ok = { name: "northwind", source: { kind: "repo", ref: "https://git.example.com/n.git#main" }, build: { image: "static" } };
  assert.ok(normalizeDraft(ok));
  for (const extra of [{ egress: true }, { egress: "yes" }, { ports: ["22:22"] }, { source: { ...ok.source, token: "x" } }, { build: { image: "static", privileged: true } }, { build: "static" }, { source: [] }]) {
    assert.throws(() => normalizeDraft({ ...ok, ...extra }), (/** @type {any} */ e) => e.code === "bad_input", JSON.stringify(extra));
  }
});

test("a Dockerfile build is a deployment of its own kind: no command, no output folder, one port", async () => {
  const { normalizeDraft, BUILD_IMAGES } = await import("./deployment.js");
  assert.ok(BUILD_IMAGES.includes("dockerfile"));
  const base = { name: "northwind", source: { kind: "folder", ref: "/srv/northwind" } };
  assert.deepEqual(normalizeDraft({ ...base, build: { image: "dockerfile", port: 8080 } }).build, { command: "", output_dir: ".", image: "dockerfile", port: 8080 });
  assert.deepEqual(normalizeDraft({ ...base, build: { image: "dockerfile" } }).build, { command: "", output_dir: ".", image: "dockerfile" });
  for (const build of [{ image: "dockerfile", command: "npm run build" }, { image: "dockerfile", output_dir: "dist" }, { image: "static", port: 80 }, { image: "dockerfile", port: 0 }, { image: "dockerfile", port: 70000 }, { image: "dockerfile", port: "80" }]) assert.throws(() => normalizeDraft({ ...base, build }), /bad_input|Dockerfile|port/i, JSON.stringify(build));
});
