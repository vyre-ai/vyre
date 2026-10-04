// @ts-check
// Sites against a fake box shaped like core/publish: groups of versions, the next step, held acts decided with the plan the person read, and the refusals.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const dep = (id, name, version, stage, extra = {}) => ({ id, name, version, stage, url: stage === "Draft" ? null : `https://${id}.preview.example`, domains: [], ...extra });
const DEPS = [dep("dep_1", "intake", 1, "Retired"), dep("dep_2", "intake", 2, "Production", { domains: [{ host: "intake.example.com", status: "verified" }] }), dep("dep_3", "intake", 3, "Preview"), dep("dep_4", "pricing", 1, "Draft"), dep("dep_5", "menu", 1, "Approved")];
const PLAN = { action: "publish", goes_public: true, deployment: { id: "dep_5", name: "menu", version: 1 }, urls: ["https://menu.example.com"], replaces: { id: "dep_9", version: 0, url: null }, secrets: [{ name: "KEY", class: "api", use: ["runtime"] }], ungranted_env: ["OTHER"], hash: "h1" };

/** @param {any} [o] */
function box(o = {}) {
  /** @type {{ tool: string, input: any }[]} */
  const seen = [];
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => {
    seen.push({ tool, input });
    if (o[tool]) return o[tool];
    if (tool === "publish.list") return { data: { deployments: DEPS } };
    if (tool === "publish.publish") return { data: { held: true, task: "task_1", plan: PLAN } };
    if (tool === "publish.decide") return { data: { task: input.task, outcome: "approved", deployment: dep("dep_5", "menu", 1, "Production") } };
    return { data: {} };
  };
  return { call, seen };
}

test("a site is every version of one name; its status says who is waiting", { skip: !strip }, async () => {
  const { sitesSource } = await import("./real-source.ts");
  const m = await import("./real-model.ts");
  const b = box();
  const ss = m.sites(await sitesSource(b.call).list());
  assert.deepEqual(b.seen, [{ tool: "publish.list", input: {} }]);
  assert.deepEqual(ss.map((s) => [s.name, s.versions.map((v) => v.version), s.live?.id ?? null, s.current.id, s.status.label]), [
    ["intake", [3, 2, 1], "dep_2", "dep_3", "In preview"], ["menu", [1], null, "dep_5", "Waiting on you"], ["pricing", [1], null, "dep_4", "Draft"],
  ]);
  assert.deepEqual(DEPS.map((d) => m.nextStep(d)?.tool ?? null), [null, null, "approve", "preview", "publish"]);
  assert.equal(m.nextStep({ ...DEPS[1], previous: "dep_1" })?.tool, "rollback");
  assert.deepEqual(DEPS.map(m.stepOf), [4, 3, 1, 0, 2]);
});

test("going live is two calls: the act answers a hold with a plan, and the person decides with exactly that plan", { skip: !strip }, async () => {
  const { sitesSource } = await import("./real-source.ts");
  const m = await import("./real-model.ts");
  const b = box();
  const s = sitesSource(b.call);
  const r = await s.act("publish", "dep_5");
  const h = m.heldOf(r);
  assert.ok(h);
  const { title, lines } = m.planLines(h.plan);
  assert.equal(title, "Put menu version 1 on the internet?");
  assert.deepEqual(lines, ["It becomes public at https://menu.example.com.", "It replaces version 0.", "Secrets it can use: KEY (runtime).", "Not granted yet, so it will not have: OTHER."]);
  await s.decide(m.decision(h));
  assert.deepEqual(b.seen.slice(1), [{ tool: "publish.decide", input: { task: "task_1", approve: true, plan_hash: "h1" } }] );
  assert.equal(m.heldOf({ deployment: {} }), null);
  assert.equal(m.planLines({ ...PLAN, action: "approve", goes_public: false, replaces: null, secrets: [], ungranted_env: [], urls: ["https://p.example"] }).lines[0], "Nothing goes public. It stays at its private preview, https://p.example.");
});

test("a new site is checked before the box is asked", { skip: !strip }, async () => {
  const { sitesSource } = await import("./real-source.ts");
  const m = await import("./real-model.ts");
  assert.match(/** @type {any} */ (m.build({ ...m.BLANK, name: "Bad Name", ref: "x" })).error, /lowercase/);
  assert.match(/** @type {any} */ (m.build({ ...m.BLANK, name: "ok" })).error, /where the source is/);
  const ok = /** @type {any} */ (m.build({ ...m.BLANK, name: " Menu ", ref: " github.com/o/r ", command: "npm run build", image: "node-22" }));
  assert.deepEqual(ok.input, { name: "menu", source: { kind: "repo", ref: "github.com/o/r" }, build: { image: "node-22", command: "npm run build" } });
  const b = box();
  await sitesSource(b.call).create(ok.input);
  assert.deepEqual(b.seen[0], { tool: "publish.create", input: ok.input });
});

test("domains and secrets are one call each; a refusal gets plain words and keeps its code", { skip: !strip }, async () => {
  const { sitesSource } = await import("./real-source.ts");
  const m = await import("./real-model.ts");
  const b = box({ "publish.domain.add": { data: { domain: { host: "x.example.com", status: "pending" }, challenge: { type: "TXT", name: "_vyre.x.example.com", value: "abc" } } }, "publish.preview": { error: { code: "sealed_in_build", message: "x" } } });
  const s = sitesSource(b.call);
  const d = await s.domainAdd("x.example.com", "dep_2");
  assert.equal(m.challengeText(d.challenge), "type: TXT\nname: _vyre.x.example.com\nvalue: abc");
  assert.equal(m.domainLine(d.domain), "Waiting for the DNS record");
  await s.domainVerify("x.example.com"); await s.secretGrant("dep_2", "vault://stripe/key", "STRIPE_KEY", ["runtime"]); await s.secretRevoke("dep_2", "STRIPE_KEY"); await s.domainRemove("x.example.com");
  assert.deepEqual(b.seen.slice(1).map((x) => x.tool), ["publish.domain.verify", "publish.secret.grant", "publish.secret.revoke", "publish.domain.remove"]);
  assert.deepEqual(b.seen[2].input, { deployment: "dep_2", ref: "vault://stripe/key", name: "STRIPE_KEY", use: ["runtime"] });
  await assert.rejects(s.preview("dep_4"), (/** @type {any} */ e) => e.code === "sealed_in_build" && /sealed value appears/.test(m.publishRefusal(e.code, e.message)));
  assert.match(m.publishRefusal("presence_required", ""), /Approve on this device/);
});
