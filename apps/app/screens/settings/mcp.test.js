// @ts-check
// The connected AI (core/mcpconn) in Settings: the rows as drawn, the words for each state, and the source's calls over a fake box.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const NOW = 1_800_000_000_000, MIN = 60_000;

test("connected AI: rows keep what is drawn, ended ones stay labelled, each state is said in words", { skip: !strip }, async () => {
  const m = await import("./mcp-model.ts");
  const rows = m.connectionsOf([
    { id: "mcn_1", client: "Claude Code", device: "Alex MacBook", created: NOW - 9 * MIN, lastUsed: NOW - 30 * MIN, revoked: false },
    { id: "mcn_2", client: "Codex", device: "Alex MacBook", created: NOW, lastUsed: null, revoked: false },
    { id: "mcn_3", client: "Old", device: "", created: 1, lastUsed: NOW - 5 * 86_400_000, revoked: true },
    { nope: 1 }, null,
  ]);
  assert.deepEqual(rows.map((r) => r.id), ["mcn_1", "mcn_2", "mcn_3"]);
  assert.deepEqual(rows.map((r) => m.usedLine(r, NOW)), ["Last used 30 minutes ago", "Not used yet", "Ended"]);
  assert.equal(m.usedLine({ ...rows[0], lastUsed: NOW - 20_000 }, NOW), "Used just now");
  assert.deepEqual(m.connectionsOf("x"), []);
  const ch = m.changesOf([{ at: NOW - 5 * MIN, client: "Claude Code", tool: "projects.create", ok: true, says: "via your Claude Code" }, { at: NOW, tool: "records.define", ok: false }, { bad: 1 }]);
  assert.equal(ch.length, 2);
  assert.equal(m.changeLine(ch[0], NOW), "projects create via your Claude Code, 5 minutes ago");
  assert.equal(m.changeLine(ch[1], NOW), "records define (refused) via your Claude Code, just now");
  assert.equal(m.LINES.codex, "codex mcp add vyre -- vyre mcp");
});

test("connected AI: the source calls mcpconn.* and shows a refusal in the box's words", { skip: !strip }, async () => {
  const { mcpSource } = await import("./mcp-source.ts");
  /** @type {{ tool: string, input: any }[]} */ const seen = [];
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => {
    seen.push({ tool, input });
    if (tool === "mcpconn.revoke") return { error: { code: "not_found", message: "no such connection" } };
    if (tool === "mcpconn.connect") return { data: { id: "mcn_9", client: "Claude Code", device: "d", lines: { claude: "c", codex: "x" } } };
    return { data: [] };
  };
  const s = mcpSource(/** @type {any} */ (call));
  assert.deepEqual(await s.list(), []);
  assert.deepEqual(await s.activity(), []);
  assert.equal((await s.connect()).id, "mcn_9");
  await s.connect("Codex");
  assert.deepEqual(seen.at(-1), { tool: "mcpconn.connect", input: { client: "Codex" } });
  await assert.rejects(s.revoke("mcn_x"), /no such connection/);
  assert.deepEqual(seen.map((x) => x.tool), ["mcpconn.list", "mcpconn.activity", "mcpconn.connect", "mcpconn.connect", "mcpconn.revoke"]);
});
