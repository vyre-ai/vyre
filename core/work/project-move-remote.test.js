// @ts-check
// The remote form of a project move and the Personal to My Cloud upgrade built on it: the device holds only the signed handle, the target pulls, and the source empties only after what arrived matches.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { planRemoteMove, runRemoteMove, upgradePersonal, batchPlanHash } from "./project-move-remote.js";

function source() {
  /** @type {Map<string, any>} */ const rows = new Map(); let n = 0;
  /** @type {Map<string, Uint8Array>} */ const files = new Map();
  const mk = (/** @type {string} */ type, /** @type {any} */ data) => { const id = `a${++n}`; const r = { id, type, urn: `vyre://A/${type}/${id}`, version: 1, data }; rows.set(r.urn, r); return r; };
  const records = {
    get: async (/** @type {any} */ _c, /** @type {string} */ type, /** @type {string} */ id) => rows.get(`vyre://A/${type}/${id}`) || null,
    update: async (/** @type {any} */ _c, /** @type {string} */ type, /** @type {string} */ id, /** @type {any} */ patch) => { const u = `vyre://A/${type}/${id}`; const r = rows.get(u); const nr = { ...r, data: { ...r.data, ...patch }, version: r.version + 1 }; rows.set(u, nr); return nr; },
    remove: async (/** @type {any} */ _c, /** @type {string} */ type, /** @type {string} */ id) => { rows.delete(`vyre://A/${type}/${id}`); },
    query: async () => ({ rows: [] }),
    linked: async (/** @type {any} */ _c, /** @type {string} */ urn) => ({ truncated: false, rows: [...rows.values()].filter(r => Object.values(r.data).some(v => v && /** @type {any} */ (v).urn === urn)).map(record => ({ record })) }),
  };
  const drive = { list: async (/** @type {any} */ _c, /** @type {string} */ prefix) => [...files].filter(([p]) => p.startsWith(prefix + "/")).map(([path, b]) => ({ path, size: b.length })), get: async (/** @type {any} */ _c, /** @type {string} */ p) => ({ bytes: files.get(p) }) };
  const proj = mk("project", { name: "Rivera", slug: "rivera", status: "active" });
  rows.set(proj.urn, { ...proj, data: { ...proj.data, drive_path: `Projects/${proj.id}` } });
  mk("chat", { title: "Intake", project: { urn: proj.urn } });
  files.set(`Projects/${proj.id}/retainer.txt`, new TextEncoder().encode("signed"));
  return { from: { space: "A", records, drive, chain: {}, types: async () => [] }, proj, rows, files };
}

function ports(/** @type {any} */ over = {}) {
  /** @type {string[]} */ const calls = [];
  const p = {
    calls,
    out: async () => { calls.push("out"); return { move_id: "mv1" }; },
    evidence: async () => { calls.push("evidence"); return { evidence: { v: 1 }, pub: "pub", sig: "sig" }; },
    receive: async (/** @type {any} */ b) => { calls.push("receive"); assert.equal(b.move_id, "mv1"); assert.equal(b.sig, "sig"); },
    pull: async (/** @type {any} */ i) => { calls.push("pull"); return { target: "vyre://B/project/b1", counts: { records: { chat: 1 }, files: i.plan.files.length + (i.plan.counts.chat_files || 0) }, files: {} }; },
    removeFiles: async (/** @type {string[]} */ f) => { calls.push("remove"); for (const x of f) over.files && over.files.delete(x); return []; },
    finish: async (/** @type {string} */ side) => { calls.push(`finish-${side}`); },
    state: {},
    ...over.ports,
  };
  return p;
}

test("a remote move: out, evidence, receive, the target's pull, a check, then the source empties and both sides finish, in that order", async () => {
  const { from, proj, rows, files } = source();
  const plan = await planRemoteMove({ from, to: { space: "B" }, project: proj.urn });
  assert.deepEqual(plan.blockers, [], "a remote target is not checked from here");
  const pt = ports({ files });
  const done = await runRemoteMove({ from, to: { space: "B" }, plan, ports: pt });
  assert.deepEqual(pt.calls, ["out", "evidence", "receive", "pull", "remove", "finish-source", "finish-target"]);
  assert.equal(done.target, "vyre://B/project/b1");
  assert.equal(rows.get(proj.urn).data.status, "moved");
  assert.equal(rows.get(proj.urn).data.moved_to, "B:vyre://B/project/b1");
  assert.equal([...rows.values()].filter(r => r.type === "chat").length, 0, "the linked records left");
  assert.equal(files.size, 0, "and the files");
  assert.ok(done.not_carried.length > 0, "what the pull cannot carry yet is said");
});

test("what arrived is checked against the plan before anything is removed", async () => {
  const { from, proj, rows } = source();
  const plan = await planRemoteMove({ from, to: { space: "B" }, project: proj.urn });
  const pt = ports({ ports: { pull: async () => ({ target: "vyre://B/project/b1", counts: { records: { chat: 0 }, files: 1 }, files: {} }) } });
  await assert.rejects(() => runRemoteMove({ from, to: { space: "B" }, plan, ports: pt }), /does not match the plan/);
  assert.equal([...rows.values()].filter(r => r.type === "chat").length, 1, "nothing was removed");
  assert.ok(!pt.calls.includes("remove") && !pt.calls.includes("finish-source"));
});

test("a dropped connection resumes: the approval, the bundle and the pull are not asked twice", async () => {
  const { from, proj, files } = source();
  const plan = await planRemoteMove({ from, to: { space: "B" }, project: proj.urn });
  const state = {};
  let drop = true;
  const pt = ports({ files, ports: { state, finish: async (/** @type {string} */ side) => { if (drop && side === "target") { drop = false; throw new Error("link dropped"); } } } });
  await assert.rejects(() => runRemoteMove({ from, to: { space: "B" }, plan, ports: pt }), /link dropped/);
  await runRemoteMove({ from, to: { space: "B" }, plan, ports: pt });
  assert.equal(pt.calls.filter((/** @type {string} */ c) => c === "out").length, 1);
  assert.equal(pt.calls.filter((/** @type {string} */ c) => c === "pull").length, 1);
  assert.equal(/** @type {any} */ (state).finished, true, "and the second run finished the move");
});

test("a project that changed since it was approved is not moved", async () => {
  const { from, proj, rows } = source();
  const plan = await planRemoteMove({ from, to: { space: "B" }, project: proj.urn });
  rows.set("vyre://A/chat/zz", { id: "zz", type: "chat", urn: "vyre://A/chat/zz", version: 1, data: { title: "new", project: { urn: proj.urn } } });
  await assert.rejects(() => runRemoteMove({ from, to: { space: "B" }, plan, ports: ports() }), /changed since/);
});

test("the Personal upgrade moves each project once: moved ones are skipped, a failure does not stop the rest, and a second run resumes from saved state", async () => {
  const mkp = (/** @type {string} */ id, /** @type {string} */ status) => ({ urn: `vyre://A/project/${id}`, data: { status } });
  const projects = [mkp("p1", "active"), mkp("p2", "moved"), mkp("p3", "active"), mkp("p4", "active")];
  /** @type {Record<string, any>} */ const states = {};
  /** @type {string[]} */ const ran = [];
  let boom = true;
  const opts = { projects, approveAll: undefined, stateOf: (/** @type {string} */ u) => (states[u] ||= {}), planOne: async (/** @type {string} */ u) => ({ project: u }), runOne: async (/** @type {any} */ plan, /** @type {any} */ st) => { ran.push(plan.project); if (plan.project.endsWith("p3") && boom) { st.partial = true; throw new Error("target unreachable"); } st.done = true; } };
  const r1 = await upgradePersonal(opts);
  assert.deepEqual(r1.moved, ["vyre://A/project/p1", "vyre://A/project/p4"]);
  assert.deepEqual(r1.skipped, ["vyre://A/project/p2"]);
  assert.equal(r1.failed.length, 1);
  assert.match(r1.failed[0].error, /unreachable/);
  boom = false;
  const r2 = await upgradePersonal({ ...opts, projects: [mkp("p1", "moved"), mkp("p2", "moved"), mkp("p3", "active"), mkp("p4", "moved")] });
  assert.deepEqual(r2.moved, ["vyre://A/project/p3"]);
  assert.equal(states["vyre://A/project/p3"].partial, true, "the project's own saved state came back");
});

test("the memory room and the Work engine's lines cross homes too: sealed to the target's key, and in the pull, each forgotten at the source only against its receipt", async () => {
  const { from, proj, files } = source();
  const plan = await planRemoteMove({ from, to: { space: "B" }, project: proj.urn });
  /** @type {string[]} */ const order = [];
  const memory = {
    offer: async () => { order.push("offer"); return { to_key: "k" }; }, export: async () => { order.push("export"); return { package: "sealed" }; },
    import: async (/** @type {any} */ i) => { order.push("import"); assert.equal(i.package, "sealed"); return { digest: "m", counts: { writes: 2 } }; },
    forget: async (/** @type {any} */ i) => { order.push("forget-memory:" + i.receipt.digest); },
  };
  const know = { forget: async (/** @type {any} */ i) => { order.push("forget-know:" + i.receipt.digest); assert.ok(i.records.includes(proj.urn)); } };
  const pt = ports({ files, ports: { memory, know, pull: async (/** @type {any} */ i) => ({ target: "vyre://B/project/b1", counts: { records: { chat: 1 }, files: i.plan.files.length }, files: {}, know: { digest: "k", count: 3 } }) } });
  const done = await runRemoteMove({ from, to: { space: "B" }, plan, ports: pt });
  assert.deepEqual(order, ["offer", "export", "import", "forget-know:k", "forget-memory:m"]);
  assert.deepEqual(done.not_carried, [], "nothing is left unsaid or behind");
});

test("the whole upgrade is ONE approval: every project is planned, the person approves the set once, and each move runs under the move id it was given", async () => {
  const mkp = (/** @type {string} */ id) => ({ urn: `vyre://A/project/${id}`, data: { status: "active" } });
  const projects = [mkp("p1"), mkp("p2"), mkp("p3")];
  /** @type {Record<string, any>} */ const states = {};
  let asked = 0; /** @type {string[][]} */ const shown = [];
  /** @type {string[]} */ const ranWith = [];
  const r = await upgradePersonal({
    projects, stateOf: (/** @type {string} */ u) => (states[u] ||= {}), planOne: async (/** @type {string} */ u) => ({ project: u, hash: `h-${u.split("/").pop()}` }),
    approveAll: async (/** @type {any[]} */ plans) => { asked++; shown.push(plans.map(p => p.hash)); return Object.fromEntries(plans.map(p => [p.project, `mv-${p.hash}`])); },
    runOne: async (/** @type {any} */ plan, /** @type {any} */ st) => { ranWith.push(st.move_id); },
  });
  assert.equal(asked, 1, "one prompt");
  assert.deepEqual(shown, [["h-p1", "h-p2", "h-p3"]], "over every project's plan");
  assert.deepEqual(ranWith, ["mv-h-p1", "mv-h-p2", "mv-h-p3"]);
  assert.equal(r.approved, 3);
  // a second run: the projects that failed keep their move id and are not asked again
  const again = await upgradePersonal({ projects, stateOf: (/** @type {string} */ u) => states[u], planOne: async (/** @type {string} */ u) => ({ project: u, hash: "x" }), approveAll: async () => { asked++; return {}; }, runOne: async () => {} });
  assert.equal(asked, 1, "no new prompt: they already hold their move ids");
  assert.equal(again.approved, 0);
});

test("the batch hash is one 43-character value over every project's plan, order-free, and any one project changing changes it", () => {
  const a = { project: "vyre://A/project/p1", hash: "h1" }, b = { project: "vyre://A/project/p2", hash: "h2" };
  const h = batchPlanHash([a, b]);
  assert.match(h, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(batchPlanHash([b, a]), h, "the order is not part of it");
  assert.notEqual(batchPlanHash([a, { ...b, hash: "h2-changed" }]), h);
  assert.notEqual(batchPlanHash([a]), h);
});
