// @ts-check
import "../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mergeSpace, spacePassages, spaceHits, spaceOnlyAnswer, SPACE_WEIGHT } from "./space.js";

const base = { passages: [{ id: "s1:1", session: "s1", seq: 1, role: "user", ts: 5, text: "turn", name: null, cwd: null, score: 0.04, via: ["question"] }, { id: "s1:2", session: "s1", seq: 2, role: "user", ts: 5, text: "weaker", name: null, cwd: null, score: 0.001, via: ["question"] }], expanded: [], window: null };
const hits = [{ source: "vyre://spc/matter/m1", kind: "record", snippet: "matter Doe estate" }, { source: "vyre://spc/event/e1", kind: "event", snippet: "signed" }];

test("Space passages are shaped like turn passages, fused by rank, and the best k are kept", () => {
  const p = spacePassages(hits);
  assert.deepEqual(p.map(x => [x.session, x.seq, x.role, x.via]), [["vyre://spc/matter/m1", 0, "space", ["space"]], ["vyre://spc/event/e1", 0, "space", ["space"]]]);
  assert.ok(p[0].score > p[1].score && p[0].score < SPACE_WEIGHT);
  const m = mergeSpace(base, hits, 3);
  assert.equal(m.passages.length, 3);
  assert.ok(m.passages.some(x => x.role === "space"));
  assert.equal(m.passages[0].id, "s1:1", "a strong turn still ranks first");
  assert.equal(mergeSpace(base, [], 3), base, "no Space hits, nothing changes");
});

test("no work module, or a refusal, is no hits and never an error", async () => {
  assert.deepEqual(await spaceHits(async () => ({ error: { code: "no_such_tool" } }), "q"), []);
  assert.deepEqual(await spaceHits(async () => { throw new Error("down"); }, "q"), []);
  assert.deepEqual(await spaceHits(async () => ({ data: { hits } }), "q"), hits);
});

test("a room's answer is the Space's alone, in the shape of an ask answer, and abstains without a cited source", async () => {
  const a = await spaceOnlyAnswer(async () => ({ data: { result: { text: "Doe signed [S1]", citations: ["vyre://spc/event/e1"], withheld: 1 } } }), "when did Doe sign");
  assert.equal(a.abstained, false);
  assert.equal(a.via, "space");
  assert.equal(a.room, true);
  assert.deepEqual(a.sources.map(s => s.session), ["vyre://spc/event/e1"]);
  assert.equal(a.withheld, 1);
  for (const reply of [{ error: { code: "x" } }, { data: { result: { text: "x", citations: [] } } }, { data: {} }]) assert.equal((await spaceOnlyAnswer(async () => reply, "q")).abstained, true);
  assert.equal((await spaceOnlyAnswer(async () => { throw new Error("down"); }, "q")).abstained, true);
});
