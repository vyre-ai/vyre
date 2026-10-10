// @ts-check
// publish: the module over a real registry with fake spaces, vault, seal, builder, names and tasks modules.
// Sample world only: alex (owner), kit (admin), sam (member), juno (a model), Harlow Legal, Northwind Bakery.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Registry, discover } from "../modules/index.js";
import { open } from "../store/index.js";
import { Events } from "../../kernel/bus.js";
import * as config from "../config/index.js";
import { tempHome, writeModule } from "../../test/helpers.js";
import { assertIsolated, composeText } from "../../lib/publish/edge.js";
import publishModule, { seams, buildctlArgs } from "./index.js";
import { fakeKernelFor } from "../../test/fake-chain-kernel.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPACE = { id: "spc_abcdefghijkl", name: "harlow.vyre.run" };
const STRIPE = "sk_live_FAKEFAKEFAKE1234";
const SSN = "123-45-6789";
const DRAFT = { name: "northwind", source: { kind: "repo", ref: "https://git.example.com/northwind.git#main" }, build: { image: "static" }, project: "bakery" };

/** The fakes the fake modules read. One object per registry, reached through globalThis. */
const fakeSource = `export default { async start(ctx) {
  const pf = () => globalThis.__publishFakes;
  const t = (name, run) => ctx.tool(name, { internal: true, input: { type: "object" }, run });
  const tools = ctx.name;
  if (tools === "spaces") {
    // A box-shaped home: it holds no identity of its own (the owner's key lives in their app), so "who is this device" cannot be answered; who is in which space can.
    t("spaces.self", async () => { throw Object.assign(new Error("Choose your Vyre name first."), { code: "no_identity" }); });
    t("spaces.merge-list", async i => pf().members[i.person] ? ({ spaces: [{ space: pf().space.id, name: pf().space.name }] }) : ({ spaces: [] }));
    t("spaces.membership", async i => pf().members[i.person] || null);
  } else if (tools === "vault") {
    t("vault.release", async i => { const v = pf().vault[i.name]; if (v === undefined) throw new Error("no such item"); return { value: v }; });
  } else if (tools === "seal") {
    t("seal.ledger.has", async i => {
      const l = pf().ledger;
      if (i.lengths) return { lengths: [...new Set(l.map(v => v.replace(/[^a-z0-9]/gi, "").length))] };
      const hits = {}; for (const c of i.candidates) if (l.some(v => v.replace(/[^a-z0-9]/gi, "").toLowerCase() === c)) hits[c] = "us-ssn";
      return { hits };
    });
  } else if (tools === "builder") {
    t("builder.build", async i => pf().build(i));
  } else if (tools === "names") {
    t("names.owns", async i => ({ owns: pf().owns(i.host, i.space) }));
    t("names.status", async () => ({ listening: pf().door === true }));
  } else if (tools === "appmods") {
    t("appmods.publish.install", async i => { pf().installs.push(i.deployment); return { name: i.deployment.name, state: "running", url: "https://x" }; });
    t("appmods.publish.remove", async () => ({ removed: true }));
  } else if (tools === "projects") {
    t("projects.reach", async () => ({ all: true }));
  } else if (tools === "tasks") {
    t("tasks.create", async i => { pf().tasks.push(i); return { id: "tsk_" + pf().tasks.length }; });
  }
  return { async stop() {} };
} };`;

const manifestOf = (/** @type {string} */ name, /** @type {string[]} */ tools) => ({ roles: ["box"], description: name, does: { tools: tools.map(n => ({ name: n, reach: "modules" })) } });
const FAKE_TOOLS = { projects: ["projects.reach"], spaces: ["spaces.self", "spaces.membership", "spaces.merge-list"], vault: ["vault.release"], seal: ["seal.ledger.has"], builder: ["builder.build"], names: ["names.owns", "names.status"], appmods: ["appmods.publish.install", "appmods.publish.remove"], tasks: ["tasks.create"] };

/**
 * A real registry with publish and the chosen fakes. @param {any} t
 * @param {{ fakes?: string[] }} [o]
 */
async function boxRegistry(t, o = {}) {
  const fakes = o.fakes || ["spaces", "vault", "seal", "builder", "names", "projects"];
  const home = tempHome(t);
  const p = config.ensure(home);
  const extra = path.join(home, "fake-modules");
  for (const n of fakes) writeModule(extra, n, manifestOf(n, /** @type {any} */ (FAKE_TOOLS)[n]), fakeSource.replace("const tools = ctx.name;", `const tools = ${JSON.stringify(n)};`));
  const pf = /** @type {any} */ ({
    space: SPACE,
    actAs: { "*": "per_alex" },
    members: {
      per_alex: { space: SPACE.id, person: "per_alex", role: "owner", added_by: "per_alex", added_at: 1 },
      per_kit: { space: SPACE.id, person: "per_kit", role: "admin", added_by: "per_alex", added_at: 1 },
      per_sam: { space: SPACE.id, person: "per_sam", role: "member", added_by: "per_alex", added_at: 1 },
    },
    vault: { "harlow/stripe": STRIPE, "config/site-title": "Northwind Bakery" },
    ledger: [SSN],
    seen: /** @type {any[]} */ ([]),
    build: async (/** @type {any} */ i) => {
      pf.seen.push({ args: i.secretArgs, modes: (i.secretArgs || []).filter((/** @type {string} */ a) => a.startsWith("id=")).map((/** @type {string} */ a) => { const f = a.split("src=")[1]; return (fs.statSync(f).mode & 0o777).toString(8); }) });
      return { digest: "sha256:" + "a".repeat(64), files: [{ path: "index.html", content: "<h1>Northwind Bakery</h1>" }], logs: "step 1 ok" };
    },
    owns: (/** @type {string} */ host, /** @type {string} */ space) => host === "northwind.vyre.run" && space === SPACE.id,
    tasks: /** @type {any[]} */ ([]),
    installs: /** @type {any[]} */ ([]),
  });
  /** @type {any} */ (globalThis).__publishFakes = pf;
  t.after(() => { delete /** @type {any} */ (globalThis).__publishFakes; });
  const found = [...discover([path.dirname(HERE)]).filter(f => f.manifest && (f.manifest.name === "publish" || (o.realBuilder && f.manifest.name === "builder"))), ...discover([extra]).filter(f => f.manifest && fakes.includes(f.manifest.name))];
  const db = open(p.db);
  const events = new Events(db);
  const reg = new Registry({ db, events, config: { role: "box", name: "testbox" }, paths: p, log: () => {}, kernelFor: (/** @type {any} */ spec) => { const k = /** @type {any} */ (fakeKernelFor)(spec); return { ...k, chain: async (/** @type {any} */ meta) => { const c = await k.chain(meta); return c.hops[0] && c.hops[0].actor.kind === "person" ? { ...c, hops: [{ actor: { kind: "person", id: pf.actAs["*"] } }, ...c.hops.slice(1)] } : c; } }; } });
  await reg.start(found, { role: "box" });
  t.after(async () => { await reg.stop(); db.close(); });
  for (const name of ["publish", ...(o.realBuilder ? ["builder"] : []), ...fakes]) assert.equal(reg.modules.get(name)?.state, "running", `${name}: ${reg.modules.get(name)?.error}`);
  /** @type {any[]} */ const seen = [];
  events.on("deployment.*", /** @param {any} e */ e => { seen.push(e); });
  const log = /** @type {any[]} */ ([]);
  /** @param {string} tool @param {any} [input] @param {string} [caller] */
  const call = async (tool, input = {}, caller = "cli") => { const r = await reg.call(tool, input, caller); log.push(r); return r; };
  /** @param {string} tool @param {any} input @param {string} [caller] */
  const ok = async (tool, input = {}, caller = "cli") => { const r = await call(tool, input, caller); assert.ok(!r.error, `${tool}: ${JSON.stringify(r.error)}`); return r.data; };
  return { reg, pf, call, ok, home, seen, log, events, publishRoot: path.join(p.root, "publish", SPACE.id) };
}

/** Create and preview one draft, returning its id. */
async function previewed(/** @type {any} */ b, /** @type {any} */ extra = {}) {
  const { deployment } = await b.ok("publish.create", { ...DRAFT, ...extra });
  await b.ok("publish.preview", { deployment: deployment.id });
  return deployment.id;
}
/** approve then publish a previewed deployment through held acts and a person's decisions. */
async function goLive(/** @type {any} */ b, /** @type {string} */ id) {
  const a = await b.ok("publish.approve", { deployment: id });
  assert.equal(a.held, true);
  await b.ok("publish.decide", { task: a.task, approve: true });
  const p = await b.ok("publish.publish", { deployment: id });
  assert.equal(p.held, true);
  return b.ok("publish.decide", { task: p.task, approve: true });
}

test("publish: create, preview, plan, approve held then decided, publish held then decided, rollback", async t => {
  const b = await boxRegistry(t);
  const { deployment: d1 } = await b.ok("publish.create", DRAFT);
  assert.equal(d1.stage, "Draft");
  assert.equal(d1.version, 1);
  const pv = await b.ok("publish.preview", { deployment: d1.id });
  assert.equal(pv.deployment.stage, "Preview");
  assert.match(pv.deployment.url, /^https:\/\/.+\.preview\.harlow\.vyre\.run$/);

  const { plan } = await b.ok("publish.plan", { deployment: d1.id });
  assert.equal(plan.action, "approve");
  assert.equal(plan.goes_public, false);

  // approve: held first, and asking again before a person decides changes nothing
  const a = await b.ok("publish.approve", { deployment: d1.id });
  assert.equal(a.held, true);
  assert.match(a.task, /^hold_/);
  const early = await b.call("publish.approve", { deployment: d1.id, task: a.task });
  assert.equal(early.error?.code, "needs_approval");
  const decided = await b.ok("publish.decide", { task: a.task, approve: true, plan_hash: a.plan.hash });
  assert.equal(decided.outcome, "approved");
  assert.equal(decided.deployment.stage, "Approved");
  assert.equal(decided.deployment.approved_by, "per_alex");

  // publish: held first, then decided
  const p = await b.ok("publish.publish", { deployment: d1.id });
  assert.equal(p.held, true);
  assert.equal(p.plan.goes_public, true);
  assert.deepEqual(p.plan.urls, ["https://northwind.harlow.vyre.run"]);
  const live = await b.ok("publish.decide", { task: p.task, approve: true });
  assert.equal(live.deployment.stage, "Production");
  // the hold is consumed: the same decision cannot be used twice
  assert.equal((await b.call("publish.decide", { task: p.task, approve: true })).error?.code, "not_found");

  // version 2, live, replaces version 1
  const id2 = await previewed(b);
  const l2 = await goLive(b, id2);
  assert.equal(l2.deployment.stage, "Production");
  assert.equal(l2.deployment.previous, d1.id);
  assert.equal(l2.retired.id, d1.id);
  assert.equal((await b.ok("publish.status", { deployment: d1.id })).stage, "Retired");

  // rollback to version 1, held then decided
  const r = await b.ok("publish.rollback", { deployment: id2 });
  assert.equal(r.held, true);
  assert.equal(r.plan.deployment.id, d1.id);
  const back = await b.ok("publish.decide", { task: r.task, approve: true });
  assert.equal(back.deployment.id, d1.id);
  assert.equal(back.deployment.stage, "Production");
  assert.equal(back.retired.id, id2);

  const list = await b.ok("publish.list", {});
  assert.deepEqual(list.deployments.map((/** @type {any} */ d) => [d.version, d.stage]).sort(), [[1, "Production"], [2, "Retired"]]);
  const types = b.seen.map(e => e.type);
  for (const type of ["deployment.built", "deployment.previewed", "deployment.approved", "deployment.published", "deployment.rolled-back", "deployment.retired"]) assert.ok(types.includes(type), type);
});

test("publish: a declined request ends the act; a decider who may not approve leaves it open", async t => {
  const b = await boxRegistry(t);
  const id = await previewed(b);
  const a = await b.ok("publish.approve", { deployment: id });
  b.pf.actAs["*"] = "per_sam"; // a member, not an approver
  assert.equal((await b.call("publish.decide", { task: a.task, approve: true })).error?.code, "not_approver");
  b.pf.actAs["*"] = "per_alex";
  const no = await b.ok("publish.decide", { task: a.task, approve: false });
  assert.equal(no.outcome, "declined");
  assert.equal((await b.ok("publish.status", { deployment: id })).stage, "Preview");
  // a decision for a plan the person did not see is refused
  const again = await b.ok("publish.approve", { deployment: id });
  assert.equal((await b.call("publish.decide", { task: again.task, approve: true, plan_hash: "0".repeat(64) })).error?.code, "approval_mismatch");
  assert.equal((await b.ok("publish.decide", { task: again.task, approve: true })).deployment.stage, "Approved");
});

test("publish: a model chain can create, preview and request, never decide, approve or publish", async t => {
  const b = await boxRegistry(t);
  const juno = "mcp:agent:juno";
  const { deployment } = await b.ok("publish.create", DRAFT, juno);
  const id = deployment.id;
  // a preview leaves Vyre, so it is outward: an agent's call is held in the approvals queue (never run) and the person's own call runs
  assert.equal((await b.call("publish.preview", { deployment: id }, juno)).error?.code, "held_unavailable");
  await b.ok("publish.preview", { deployment: id });

  const a = await b.ok("publish.approve", { deployment: id }, juno);
  assert.equal(a.held, true, "a model's approve is a request");
  // the model cannot decide: the registry refuses it, and a model cannot resume an undecided request
  assert.equal((await b.call("publish.decide", { task: a.task, approve: true }, juno)).error?.code, "denied");
  assert.equal((await b.call("publish.approve", { deployment: id, task: a.task }, juno)).error?.code, "needs_approval");
  assert.equal((await b.ok("publish.status", { deployment: id }, juno)).stage, "Preview");

  // once a person decided, the model's own call is only a resume of what the person approved
  await b.ok("publish.decide", { task: a.task, approve: true });
  const p = await b.ok("publish.publish", { deployment: id }, juno);
  assert.equal(p.held, true, "a model's publish is a request");
  assert.equal((await b.call("publish.publish", { deployment: id, task: p.task }, juno)).error?.code, "needs_approval");
  assert.equal((await b.ok("publish.status", { deployment: id }, juno)).stage, "Approved");
  // a module's own service chain is no person's: it is refused, not held (BR-2: the person comes from the call's chain only)
  assert.equal((await b.call("publish.publish", { deployment: id }, "module:flow")).error?.code, "forbidden");
  // a decision by a person publishes it
  assert.equal((await b.ok("publish.decide", { task: p.task, approve: true })).deployment.stage, "Production");
});

test("publish: on a box-shaped home (no identity of its own, a hosted space, a paired person) the owner publishes and a non-member is refused", async t => {
  const b = await boxRegistry(t);
  const made = await b.call("publish.create", DRAFT);
  assert.ok(!made.error, JSON.stringify(made.error));
  b.pf.actAs["*"] = "per_stranger";
  assert.equal((await b.call("publish.create", { ...DRAFT, name: "other" })).error?.code, "forbidden", "a person who is in no space here is refused");
  b.pf.actAs["*"] = "per_alex";
  assert.equal((await b.call("publish.create", { ...DRAFT, name: "third", space: "someone-else.vyre.run" })).error?.code, "forbidden", "a space the person is not in is refused");
});

test("publish: a role without the ability is refused", async t => {
  const b = await boxRegistry(t);
  b.pf.actAs["*"] = "per_sam";
  const r = await b.call("publish.create", DRAFT);
  assert.equal(r.error?.code, "forbidden");
  b.pf.actAs["*"] = "per_stranger"; // not a member at all
  assert.equal((await b.call("publish.create", DRAFT)).error?.code, "forbidden");
  b.pf.actAs["*"] = "per_alex";
  const id = await previewed(b);
  b.pf.actAs["*"] = "per_sam";
  assert.equal((await b.call("publish.retire", { deployment: id })).error?.code, "forbidden");
  assert.equal((await b.call("publish.secret.grant", { deployment: id, ref: "vault://harlow/stripe", name: "STRIPE_KEY" })).error?.code, "forbidden");
  assert.ok(!(await b.call("publish.status", { deployment: id })).error, "a member can see status");
});

test("publish: domains are verified by a DNS record, or by owning the name", async t => {
  const b = await boxRegistry(t);
  const id = await previewed(b);
  const add = await b.ok("publish.domain.add", { host: "shop.example.com", deployment: id });
  assert.equal(add.domain.status, "pending");
  assert.equal(add.challenge.type, "TXT");
  assert.match(add.challenge.name, /shop\.example\.com$/);

  const real = seams.dns;
  t.after(() => { seams.dns = real; });
  /** @type {Record<string, string[][]>} */ const txt = {};
  seams.dns = { resolveTxt: async name => { if (!(name in txt)) throw Object.assign(new Error("ENODATA"), { code: "ENODATA" }); return txt[name]; } };

  const missing = await b.ok("publish.domain.verify", { host: "shop.example.com" });
  assert.equal(missing.verified, false);
  assert.equal(missing.reason, "no_record");
  txt[add.challenge.name] = [["vyre-publish=wrong"]];
  assert.equal((await b.ok("publish.domain.verify", { host: "shop.example.com" })).reason, "mismatch");
  txt[add.challenge.name] = [[add.challenge.value]];
  const done = await b.ok("publish.domain.verify", { host: "shop.example.com" });
  assert.equal(done.verified, true);
  assert.equal(done.domain.status, "verified");
  assert.deepEqual((await b.ok("publish.status", { deployment: id })).domains, [{ host: "shop.example.com", status: "verified" }]);

  // a vyre.run name is verified by owning it, through the names module
  const mine = await b.ok("publish.domain.add", { host: "northwind.vyre.run", deployment: id });
  assert.equal(mine.challenge.type, "names");
  assert.equal((await b.ok("publish.domain.verify", { host: "northwind.vyre.run" })).verified, true);
  const theirs = await b.ok("publish.domain.add", { host: "someone-else.vyre.run", deployment: id });
  assert.equal(theirs.challenge.type, "names");
  assert.equal((await b.ok("publish.domain.verify", { host: "someone-else.vyre.run" })).reason, "not_owner");

  assert.deepEqual(await b.ok("publish.domain.remove", { host: "shop.example.com" }), { removed: "shop.example.com" });
  assert.equal((await b.call("publish.domain.verify", { host: "shop.example.com" })).error?.code, "not_found");
});

test("publish: a secret granted to deployment A is absent from B, written 0400 for the build and removed after", async t => {
  const b = await boxRegistry(t);
  const a = (await b.ok("publish.create", DRAFT)).deployment.id;
  const other = (await b.ok("publish.create", { ...DRAFT, name: "bakery-blog" })).deployment.id;

  // a real secret is held for a person, as a model's request or a person's own
  const held = await b.ok("publish.secret.grant", { deployment: a, ref: "vault://harlow/stripe", name: "STRIPE_KEY", use: ["build"] }, "mcp:agent:juno");
  assert.equal(held.held, true);
  assert.equal(held.plan.secret.class, "secret");
  assert.equal((await b.ok("publish.status", { deployment: a })).secrets.length, 0, "nothing granted until a person decides");
  const granted = await b.ok("publish.decide", { task: held.task, approve: true });
  assert.deepEqual(granted.deployment.secrets, [{ name: "STRIPE_KEY", class: "secret", use: ["build"] }]);

  await b.ok("publish.preview", { deployment: a });
  await b.ok("publish.preview", { deployment: other });
  assert.equal(b.pf.seen[0].args.length, 2);
  assert.match(b.pf.seen[0].args[1], /^id=STRIPE_KEY,src=.*\/publish\/spc_abcdefghijkl\/secrets\/dep_[0-9a-f]{16}\/STRIPE_KEY$/);
  assert.deepEqual(b.pf.seen[0].modes, ["400"]);
  assert.deepEqual(b.pf.seen[1].args, [], "B was granted nothing");
  assert.equal(fs.existsSync(path.join(b.publishRoot, "secrets", a, "STRIPE_KEY")), false, "the build file is removed after the build");
  assert.deepEqual((await b.ok("publish.status", { deployment: other })).secrets, []);

  // a secret that shows up in the build output refuses the build
  b.pf.build = async () => ({ digest: "sha256:" + "b".repeat(64), files: [{ path: "app.js", content: `const k = "${STRIPE}";` }], logs: "ok" });
  const third = (await b.ok("publish.create", { ...DRAFT, name: "third" })).deployment.id;
  await b.ok("publish.secret.grant", { deployment: third, ref: "vault://config/site-title", name: "SITE_TITLE", use: ["build"] });
  const again = (await b.ok("publish.create", { ...DRAFT, name: "fourth" })).deployment.id;
  const g = await b.ok("publish.secret.grant", { deployment: again, ref: "vault://harlow/stripe", name: "STRIPE_KEY", use: ["build"] });
  await b.ok("publish.decide", { task: g.task, approve: true });
  assert.equal((await b.call("publish.preview", { deployment: again })).error?.code, "secret_in_build");

  // an item the vault does not have is a plain error
  const g2 = await b.ok("publish.secret.grant", { deployment: third, ref: "vault://harlow/missing", name: "MISSING_KEY", use: ["build"] });
  await b.ok("publish.decide", { task: g2.task, approve: true });
  const miss = await b.call("publish.preview", { deployment: third });
  assert.ok(miss.error);
});

test("publish: a sealed value in the build output or logs refuses the build, in any common form", async t => {
  const b = await boxRegistry(t);
  const id = (await b.ok("publish.create", DRAFT)).deployment.id;
  const forms = [
    { files: [{ path: "index.html", content: `<p>${SSN}</p>` }], logs: "ok" },
    { files: [{ path: "index.html", content: "<p>fine</p>" }], logs: `debug ${SSN.replace(/-/g, " ")}` },
    { files: [{ path: "a.js", content: `var x="${Buffer.from(SSN).toString("base64")}"` }], logs: "ok" },
  ];
  for (const f of forms) {
    b.pf.build = async () => ({ digest: "sha256:" + "c".repeat(64), ...f });
    const r = await b.call("publish.preview", { deployment: id });
    assert.equal(r.error?.code, "sealed_in_build", JSON.stringify(f).slice(0, 60));
    assert.ok(!JSON.stringify(r).includes(SSN), "the value never appears in the refusal");
  }
  assert.equal((await b.ok("publish.status", { deployment: id })).stage, "Draft");
  // a clean build passes the same check
  b.pf.build = async () => ({ digest: "sha256:" + "d".repeat(64), files: [{ path: "index.html", content: "<p>fine</p>" }], logs: "ok" });
  assert.equal((await b.ok("publish.preview", { deployment: id })).deployment.stage, "Preview");
});

test("publish: with no seal module the status says sealed values are not checked", async t => {
  const b = await boxRegistry(t, { fakes: ["spaces", "vault", "builder"] });
  const id = await previewed(b);
  const s = await b.ok("publish.status", { deployment: id });
  assert.match(s.sealed_check, /no ledger/);
  const withLedger = await boxRegistry(t);
  const id2 = await previewed(withLedger);
  assert.equal((await withLedger.ok("publish.status", { deployment: id2 })).sealed_check, "ledger connected");
});

test("publish: with no builder installed, preview says so in plain words", async t => {
  const b = await boxRegistry(t, { fakes: ["spaces", "vault", "seal"] });
  const { deployment } = await b.ok("publish.create", DRAFT);
  const r = await b.call("publish.preview", { deployment: deployment.id });
  assert.equal(r.error?.code, "no_builder");
  assert.match(r.error.message, /no builder installed/);
});

test("publish: with no vault, granting then building says no vault secret store is available", async t => {
  const b = await boxRegistry(t, { fakes: ["spaces", "builder"] });
  const id = (await b.ok("publish.create", DRAFT)).deployment.id;
  const g = await b.ok("publish.secret.grant", { deployment: id, ref: "vault://harlow/stripe", name: "STRIPE_KEY", use: ["build"] });
  await b.ok("publish.decide", { task: g.task, approve: true });
  const r = await b.call("publish.preview", { deployment: id });
  assert.equal(r.error?.code, "no_vault");
  assert.match(r.error.message, /no vault secret store available/);
});

test("publish: edge writes the compose project and Caddyfile with their modes, isolated, and runtime secrets 0600", async t => {
  const b = await boxRegistry(t);
  b.pf.build = async () => ({ digest: "sha256:" + "e".repeat(64), files: [{ path: "server.js", content: "console.log(1)" }], logs: "ok", runtime: { kind: "node", image: "node:22-alpine", port: 3000 } });
  const id = (await b.ok("publish.create", { ...DRAFT, build: { image: "node-22", command: "npm run build" } })).deployment.id;
  const g = await b.ok("publish.secret.grant", { deployment: id, ref: "vault://harlow/stripe", name: "STRIPE_KEY", use: ["runtime"] });
  await b.ok("publish.decide", { task: g.task, approve: true });
  await b.ok("publish.preview", { deployment: id });
  await goLive(b, id);
  await b.ok("publish.domain.add", { host: "northwind.vyre.run", deployment: id });
  await b.ok("publish.domain.verify", { host: "northwind.vyre.run" });

  const e = await b.ok("publish.edge", {});
  assert.equal(e.dir, b.publishRoot);
  assert.deepEqual(e.files.map((/** @type {any} */ f) => [f.path, f.mode]), [["compose.yaml", "0644"], ["Caddyfile", "0644"], ["caddy.Dockerfile", "0644"], ["join.html", "0644"], [`secrets/${id}/STRIPE_KEY`, "0600"]]);
  const mode = (/** @type {string} */ rel) => (fs.statSync(path.join(b.publishRoot, rel)).mode & 0o777).toString(8);
  assert.equal(mode("compose.yaml"), "644");
  assert.equal(mode("Caddyfile"), "644");
  assert.equal(mode(`secrets/${id}/STRIPE_KEY`), "600");
  assert.equal(fs.readFileSync(path.join(b.publishRoot, `secrets/${id}/STRIPE_KEY`), "utf8"), STRIPE);
  assert.equal(fs.readFileSync(path.join(b.publishRoot, "compose.yaml"), "utf8"), composeText(e.compose));
  assert.equal(fs.readFileSync(path.join(b.publishRoot, "Caddyfile"), "utf8"), e.caddyfile);
  assert.equal(assertIsolated(e.compose), true);
  assert.ok(e.compose.services.caddy && e.compose.services.buildkit);
  assert.match(e.caddyfile, /northwind\.vyre\.run/);

  // revoking the secret removes its file
  await b.ok("publish.secret.revoke", { deployment: id, name: "STRIPE_KEY" });
  assert.equal(fs.existsSync(path.join(b.publishRoot, `secrets/${id}/STRIPE_KEY`)), false);
});

test("publish: edge.up writes the edge then builds, fills and brings it up through docker; without docker it says not_available", async t => {
  const b = await boxRegistry(t);
  const id = (await b.ok("publish.create", DRAFT)).deployment.id;
  await b.ok("publish.preview", { deployment: id });
  await goLive(b, id);
  const real = seams.docker;
  t.after(() => { seams.docker = real; });
  seams.docker = null;
  const none = await b.call("publish.edge.up", {});
  assert.equal(none.error?.code, "not_available");
  assert.ok(fs.existsSync(path.join(b.publishRoot, "compose.yaml")), "the files are written even so");
  /** @type {string[][]} */ const calls = [];
  seams.docker = async argv => { calls.push(argv); return { code: 0 }; };
  const up = await b.ok("publish.edge.up", {});
  assert.match(up.project, /^vyre-publish-spc_/);
  assert.deepEqual(calls.map(c => c[0]), ["build", "run", "compose"]);
  assert.ok(calls[0].includes(path.join(b.publishRoot, "caddy.Dockerfile")));
  seams.docker = async argv => { calls.push(argv); return { code: 1 }; };
  assert.equal((await b.call("publish.edge.up", {})).error?.code, "edge_failed");
  seams.docker = async argv => { calls.push(argv); return { code: 0 }; };
  assert.deepEqual((await b.ok("publish.edge.down", {})).stopped, up.project);
  assert.deepEqual(calls.at(-1).slice(0, 4), ["compose", "-p", up.project, "stop"]);
});

test("publish: nothing sensitive leaves in events or returned objects", async t => {
  const b = await boxRegistry(t);
  const id = (await b.ok("publish.create", DRAFT)).deployment.id;
  assert.equal((await b.call("publish.secret.grant", { deployment: id, ref: "vault://harlow/stripe", name: "STRIPE_KEY", use: ["build", "runtime"] })).error?.code, "isolation", "a static site takes no runtime secret");
  const g = await b.ok("publish.secret.grant", { deployment: id, ref: "vault://harlow/stripe", name: "STRIPE_KEY", use: ["build"] });
  await b.ok("publish.decide", { task: g.task, approve: true });
  b.pf.build = async () => ({ digest: "sha256:" + "f".repeat(64), files: [{ path: "index.html", content: "<p>x</p>" }], logs: `building with ${STRIPE}` });
  const pv = await b.ok("publish.preview", { deployment: id });
  assert.ok(!pv.logs.includes(STRIPE), "granted secrets are redacted from logs");
  assert.match(pv.logs, /\[secret:STRIPE_KEY\]/);
  await goLive(b, id);
  await b.ok("publish.edge", {});
  await b.ok("publish.status", { deployment: id });
  await b.ok("publish.list", {});
  await b.ok("publish.flow", { deployment: id });
  const everything = JSON.stringify([b.log, b.seen]);
  for (const bad of [STRIPE, SSN]) assert.ok(!everything.includes(bad), "no secret or sealed value anywhere");
  assert.ok(!JSON.stringify(b.seen).includes("hops"), "events carry no chain");
});

test("publish: the Flow for a deployment is the pipeline definition", async t => {
  const b = await boxRegistry(t);
  const id = (await b.ok("publish.create", DRAFT)).deployment.id;
  const { flow } = await b.ok("publish.flow", { deployment: id });
  assert.deepEqual(flow.steps.map((/** @type {any} */ s) => s.id), ["build", "preview", "approve", "production", "rollback"]);
  assert.equal(flow.authorship, "system");
  assert.equal((await b.call("publish.flow", { deployment: "dep_0000000000000000" })).error?.code, "not_found");
  // The stored form the Flows runner takes (kernel/flows/schema.js): a manual trigger, the deploy caps over this deployment, an ask and an outward production.
  const kernel = (await b.ok("publish.flow", { deployment: id, kernel: true })).flow;
  assert.equal(kernel.format, 1);
  assert.equal(kernel.trigger.on, "manual");
  assert.deepEqual(kernel.steps.map((/** @type {any} */ s) => s.id), ["build", "preview", "approve", "decide_publish"]);
});

test("publish: a task goes to the tasks module when it exists, and the hold works the same", async t => {
  const b = await boxRegistry(t, { fakes: ["spaces", "vault", "seal", "builder", "tasks"] });
  const id = await previewed(b);
  const a = await b.ok("publish.approve", { deployment: id });
  assert.match(a.task, /^tsk_1$/);
  assert.equal(b.pf.tasks.length, 1);
  assert.match(b.pf.tasks[0].title, /Approve the preview of northwind/);
  assert.equal((await b.ok("publish.decide", { task: a.task, approve: true })).deployment.stage, "Approved");
});

test("publish: without a spaces module nothing runs and the reason is plain", async t => {
  const b = await boxRegistry(t, { fakes: ["vault", "builder"] });
  const r = await b.call("publish.create", DRAFT);
  assert.equal(r.error?.code, "no_space");
});

test("publish: the build command plan is argv for buildctl with the secret files and nothing else sensitive", () => {
  const argv = buildctlArgs({ id: "dep_" + "0".repeat(16), build: { image: "node-22", output_dir: "dist" } }, { context: "/work/src", out: "/work/out", secretArgs: ["--secret", "id=STRIPE_KEY,src=/p/secrets/x/STRIPE_KEY"] });
  assert.equal(argv[0], "buildctl");
  assert.ok(argv.includes("--secret") && argv.includes("id=STRIPE_KEY,src=/p/secrets/x/STRIPE_KEY"));
  assert.ok(argv.includes("type=local,dest=/work/out"));
  assert.ok(!argv.join(" ").includes("sk_"));
});

test("publish: the module's tables and tools are its own", () => {
  assert.equal(typeof publishModule.start, "function");
  const m = JSON.parse(fs.readFileSync(path.join(HERE, "module.json"), "utf8"));
  assert.ok(m.does.tools.every((/** @type {any} */ x) => x.name.startsWith("publish.")));
  assert.deepEqual(m.does.tools.filter((/** @type {any} */ x) => x.reach === "person").map((/** @type {any} */ x) => x.name).sort(), ["publish.decide", "publish.domain.remove", "publish.retire"]);
});

test("publish: a build that hands over a link, or a path that climbs out, is refused before anything is previewed (a symlink in a site would serve /etc/passwd or a dotfile)", async t => {
  const b = await boxRegistry(t);
  const id = (await b.ok("publish.create", DRAFT)).deployment.id;
  for (const evil of [{ path: "p", type: "symlink", target: "/etc/passwd", content: "" }, { path: "e", symlink: ".env", content: "" }, { path: "../x", content: "x" }]) {
    b.pf.build = async () => ({ digest: "sha256:" + "f".repeat(64), files: [{ path: "index.html", content: "<p>x</p>" }, evil], logs: "" });
    assert.equal((await b.call("publish.preview", { deployment: id })).error?.code, "bad_output", JSON.stringify(evil));
  }
  assert.equal((await b.ok("publish.status", { deployment: id })).stage, "Draft");
});

test("publish: a static build's files are written once checked, and the edge hands the box the copy into the site volume; a link in the build writes nothing", async t => {
  const b = await boxRegistry(t);
  const id = (await b.ok("publish.create", DRAFT)).deployment.id;
  const sitesDir = path.join(b.publishRoot, "sites");
  b.pf.build = async () => ({ digest: "sha256:" + "f".repeat(64), files: [{ path: "index.html", content: "<p>x</p>" }, { path: "p", type: "symlink", target: "/etc/passwd", content: "" }], logs: "" });
  assert.equal((await b.call("publish.preview", { deployment: id })).error?.code, "bad_output");
  assert.ok(!fs.existsSync(sitesDir) || fs.readdirSync(sitesDir).length === 0, "a link in the hand-off writes nothing");
  b.pf.build = async () => ({ digest: "sha256:" + "f".repeat(64), files: [{ path: "index.html", content: "<h1>ok</h1>" }, { path: "a/b.css", content: "x" }], logs: "" });
  await b.ok("publish.preview", { deployment: id });
  const made = fs.readdirSync(sitesDir);
  assert.equal(made.length, 1);
  assert.equal(fs.readFileSync(path.join(sitesDir, made[0], "index.html"), "utf8"), "<h1>ok</h1>");
  await goLive(b, id);
  const e = await b.ok("publish.edge", {});
  assert.equal(e.fills.length, 1);
  assert.equal(e.fills[0].deployment, id);
  assert.match(e.fills[0].volume, /_site-[0-9a-f]{16}$/);
  // FF-1: edit the stored record to point anywhere else and the edge hands out no fill for it
  const db = b.reg.deps.db;
  const row = JSON.parse(db.prepare("SELECT body FROM publish_deployments WHERE id = ?").get(id).body);
  const tamper = (/** @type {any} */ site) => db.prepare("UPDATE publish_deployments SET body = ? WHERE id = ?").run(JSON.stringify({ ...row, site }), id);
  for (const evil of [{ dir: "/etc" }, { name: "/etc" }, { name: "../../etc" }, { name: "site-ABCDEF" }, { name: "site-../x" }, { name: 7 }]) {
    tamper(evil);
    assert.deepEqual((await b.ok("publish.edge", {})).fills, [], JSON.stringify(evil));
  }
  fs.symlinkSync("/etc", path.join(sitesDir, "site-LINK01"));
  tamper({ name: "site-LINK01" });
  assert.deepEqual((await b.ok("publish.edge", {})).fills, [], "a link named like a site folder");
  tamper(row.site);
  assert.ok(e.fills[0].docker.includes("--network") && e.fills[0].docker.includes(`${path.join(sitesDir, made[0])}:/in:ro`));
});

test("publish: a retired or superseded deployment's site folder is removed, and a folder no deployment names is swept", async t => {
  const b = await boxRegistry(t);
  const id = (await b.ok("publish.create", DRAFT)).deployment.id;
  const sitesDir = path.join(b.publishRoot, "sites");
  b.pf.build = async () => ({ digest: "sha256:" + "f".repeat(64), files: [{ path: "index.html", content: "<h1>1</h1>" }], logs: "" });
  await b.ok("publish.preview", { deployment: id });
  const first = fs.readdirSync(sitesDir);
  assert.equal(first.length, 1);
  fs.mkdirSync(path.join(sitesDir, "site-ORPHAN"), { mode: 0o700 });
  const longAgo = new Date(Date.now() - 2 * 86_400_000);
  fs.utimesSync(path.join(sitesDir, "site-ORPHAN"), longAgo, longAgo);
  fs.mkdirSync(path.join(sitesDir, "site-YOUNG1"), { mode: 0o700 });
  const id2 = (await b.ok("publish.create", { ...DRAFT, name: "kit" })).deployment.id;
  await b.ok("publish.preview", { deployment: id2 });
  const now = fs.readdirSync(sitesDir).sort();
  assert.ok(!now.includes("site-ORPHAN"), "an old unnamed folder is swept");
  assert.ok(now.includes("site-YOUNG1"), "a young one is not: it may be a preview still being stored");
  assert.ok(now.includes(first[0]) && now.length === 3, "both live previews keep theirs");
});

test("publish: two previews at once keep both site folders (a folder is written before its record exists)", async t => {
  const b = await boxRegistry(t);
  const sitesDir = path.join(b.publishRoot, "sites");
  const ids = [];
  for (const name of ["one", "two", "three", "four"]) ids.push((await b.ok("publish.create", { ...DRAFT, name })).deployment.id);
  b.pf.build = async () => ({ digest: "sha256:" + "f".repeat(64), files: [{ path: "index.html", content: "<p>x</p>" }], logs: "" });
  await Promise.all(ids.map(id => b.call("publish.preview", { deployment: id })));
  const records = (await Promise.all(ids.map(id => b.ok("publish.status", { deployment: id }))));
  assert.equal(fs.readdirSync(sitesDir).length, 4);
  void records;
  const db = b.reg.deps.db;
  for (const id of ids) {
    const row = JSON.parse(db.prepare("SELECT body FROM publish_deployments WHERE id = ?").get(id).body);
    assert.ok(row.site && fs.existsSync(path.join(sitesDir, row.site.name)), `${id}'s folder is there`);
  }
});

test("publish: a folder of ready files builds with the real builder, is checked, written for the box, previewed and refused when it needs a command", async t => {
  const b = await boxRegistry(t, { fakes: ["spaces", "vault", "seal", "names", "projects"], realBuilder: true });
  const dir = fs.mkdtempSync(path.join(b.home, "site-src-"));
  fs.writeFileSync(path.join(dir, "index.html"), "<h1>Northwind Bakery</h1>");
  fs.writeFileSync(path.join(dir, ".env"), "KEY=left-out");
  const { deployment } = await b.ok("publish.create", { name: "bakery", source: { kind: "folder", ref: dir }, build: { image: "static" }, project: "bakery" });
  assert.equal(deployment.stage, "Draft");
  const pv = await b.ok("publish.preview", { deployment: deployment.id });
  assert.equal(pv.deployment.stage, "Preview");
  assert.match(pv.logs, /^Read 1 file \(1 KB\) from site-src-[A-Za-z0-9]+; left out: \.env\.$/);
  const sitesDir = path.join(b.publishRoot, "sites");
  const made = fs.readdirSync(sitesDir);
  assert.equal(made.length, 1);
  assert.deepEqual(fs.readdirSync(path.join(sitesDir, made[0])), ["index.html"], "only the site's files were written for the box; the .env stayed behind");
  // a build command is for the container builder, which this server does not have: Publish says so in the builder's words
  const { deployment: cmd } = await b.ok("publish.create", { name: "bakery-app", source: { kind: "folder", ref: dir }, build: { image: "static", command: "npm run build", output_dir: "dist" }, project: "bakery" });
  const refused = await b.call("publish.preview", { deployment: cmd.id });
  assert.match(refused.error.message, /needs the container builder, which is not installed here yet/);
  // a folder that is not on this server is refused at create, before any draft exists
  const gone = await b.call("publish.create", { name: "ghost", source: { kind: "folder", ref: path.join(b.home, "nope") }, build: { image: "static" } });
  assert.equal(gone.error.code, "not_found");
});

test("publish: quick takes a folder of ready files to live on one decision, with the real builder; a decision for one site is not a decision for another", async t => {
  const b = await boxRegistry(t, { fakes: ["spaces", "vault", "seal", "names", "projects"], realBuilder: true });
  const dir = fs.mkdtempSync(path.join(b.home, "site-src-"));
  fs.writeFileSync(path.join(dir, "index.html"), "<h1>Northwind Bakery</h1>");
  const q = await b.ok("publish.quick", { name: "bakery", folder: dir, project: "bakery" });
  assert.equal(q.held, true);
  assert.equal(q.deployment.stage, "Preview");
  assert.equal(q.plan.goes_public, true, "what the person says yes to is the public plan");
  assert.match(q.logs, /^Read 1 file/);
  assert.deepEqual(q.plan.files.paths, ["index.html"], "the plan lists what would go public");
  assert.equal(q.public, false);
  assert.match(q.note, /^Public once the public door is on\./, "with no public door the answer says so, beside the yes");
  const q2 = await b.ok("publish.quick", { name: "bakery-two", folder: dir, project: "bakery" });
  globalThis.__publishFakes.door = true;
  const q3 = await b.ok("publish.quick", { name: "bakery-three", folder: dir, project: "bakery" });
  assert.equal(q3.public, true);
  assert.equal(q3.note, undefined, "with the door on there is nothing to wait for");
  globalThis.__publishFakes.door = false;
  const wrong = await b.call("publish.decide", { task: q2.task, approve: true, plan_hash: q.plan.hash });
  assert.equal(wrong.error?.code, "approval_mismatch", "a hash for another plan is refused");
  const done = await b.ok("publish.decide", { task: q.task, approve: true, plan_hash: q.plan.hash });
  assert.equal(done.deployment.stage, "Production");
  assert.equal((await b.ok("publish.status", { deployment: q2.deployment.id })).stage, "Preview", "the other site is still only a preview");
  const refused = await b.call("publish.quick", { name: "ghost", folder: path.join(b.home, "nope") });
  assert.equal(refused.error?.code, "not_found");
});

test("publish: a key changed in the Vault restarts the live server that holds it for runtime, once, and no other site", async t => {
  const { seams } = await import("./index.js");
  seams.restartMs = 20;
  t.after(() => { seams.restartMs = undefined; });
  const b = await boxRegistry(t, { fakes: ["spaces", "vault", "seal", "builder", "names", "projects", "appmods"] });
  b.pf.build = async () => ({ digest: "sha256:" + "f".repeat(64), files: [], logs: "ok", runtime: { kind: "image", image: "sha256:" + "f".repeat(64), port: 8080, health: { path: "/", ok: [200] } } });
  const mk = async (/** @type {string} */ name, /** @type {string} */ use) => {
    const id = (await b.ok("publish.create", { ...DRAFT, name, build: { image: "node-22", command: "npm run build" } })).deployment.id;
    const g = await b.ok("publish.secret.grant", { deployment: id, ref: "vault://harlow/stripe", name: "STRIPE_KEY", use: [use] });
    await b.ok("publish.decide", { task: g.task, approve: true });
    await b.ok("publish.preview", { deployment: id });
    await goLive(b, id);
    return id;
  };
  const runtimeId = await mk("northwind-run", "runtime");
  await mk("northwind-build", "build");
  const installs = () => b.pf.installs.filter((/** @type {any} */ d) => d.id === runtimeId).length;
  const before = installs();
  assert.ok(before >= 1, "it was installed when it went live");
  const until = async (/** @type {() => boolean} */ f) => { for (let i = 0; i < 100 && !f(); i++) await new Promise(r => setTimeout(r, 30)); return f(); };

  b.events.emit("vault", "vault.item-changed", { name: "unrelated", kind: "secret" });
  b.events.emit("vault", "vault.item-changed", { name: "harlow/stripe", kind: "secret" });
  b.events.emit("vault", "vault.item-changed", { name: "harlow/stripe", kind: "secret" });
  assert.ok(await until(() => installs() === before + 1), "the server holding the key was started again with the new value");
  await new Promise(r => setTimeout(r, 200));
  assert.equal(installs(), before + 1, "once for a burst of changes");
  assert.equal(b.pf.installs.filter((/** @type {any} */ d) => d.name === "northwind-build").length, 1, "a site that only uses the key to build is not restarted");
});
