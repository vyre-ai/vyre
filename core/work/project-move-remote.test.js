// @ts-check
// The remote form of a project move and the Personal to My Cloud upgrade built on it: the device holds only the signed handle, the target pulls, and the source empties only after what arrived matches.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { planRemoteMove, runRemoteMove, upgradePersonal } from "./project-move-remote.js";

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
  const opts = { projects, stateOf: (/** @type {string} */ u) => (states[u] ||= {}), planOne: async (/** @type {string} */ u) => ({ project: u }), runOne: async (/** @type {any} */ plan, /** @type {any} */ st) => { ran.push(plan.project); if (plan.project.endsWith("p3") && boom) { st.partial = true; throw new Error("target unreachable"); } st.done = true; } };
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
