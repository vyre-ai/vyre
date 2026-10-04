// @ts-check
// recall.transcript inside a real vyred: a session found by id or prefix read as blocks, and the
// tool kept to a person's own surfaces.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../daemon/index.js";
import { request, call } from "../daemon/client.js";
import { tempHome } from "../../test/helpers.js";

const RICH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "transcripts", "fixtures", "rich.jsonl");
const ID = "22222222-bbbb-4000-8000-000000000002";

async function vyred(t) {
  const root = tempHome(t);
  const dir = path.join(root, "transcripts");
  fs.mkdirSync(path.join(dir, "-home-alex-Work-northwind-bakery"), { recursive: true });
  fs.copyFileSync(RICH, path.join(dir, "-home-alex-Work-northwind-bakery", `${ID}.jsonl`));
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ transcripts: [dir], recall: { every: 0, vectors: false } }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  await call("recall.index", {}, { root });
  return root;
}

test("recall.transcript: a session by prefix, as blocks with its name and folder", async t => {
  const root = await vyred(t);
  const r = (await call("recall.transcript", { session: "22222222-bb" }, { root })).data;
  assert.deepEqual(r.session, { id: ID, cwd: "/home/alex/Work/northwind-bakery", name: "Northwind order form",
    title: r.session.title });
  assert.equal(typeof r.session.title, "string");
  assert.equal(r.blocks.length, 15);
  assert.equal(r.first, 2);
  assert.equal(r.next, 20);
  const tool = r.blocks.find(b => b.kind === "tool" && b.tool === "Bash" && b.error);
  assert.equal(tool.output, "Error: missing STRIPE_KEY for deploy");
  assert.ok(!JSON.stringify(r).includes("NorthwindBakery0000fake"), "a pasted key left the tool");

  const page = (await call("recall.transcript", { session: ID, from: 20 }, { root })).data;
  assert.deepEqual(page.blocks.map(b => `${b.seq}:${b.kind}`), ["20:user", "21:text", "21:turn"]);
  const back = (await call("recall.transcript", { session: ID, before: 20, limit: 3 }, { root })).data;
  assert.deepEqual(back.blocks.map(b => `${b.seq}:${b.kind}`), ["16:tool", "18:text", "20:turn"]);

  const none = await call("recall.transcript", { session: "nope" }, { root });
  assert.equal(none.error?.code, "not_found", "no file at all is a quiet not_found, not a failure");
});

test("recall.transcript: a person's surfaces only, never MCP or an agent", async t => {
  const root = await vyred(t);
  for (const caller of ["mcp", "mcp:agent:juno"]) {
    const r = await call("recall.transcript", { session: ID }, { root, caller });
    assert.equal(r.error?.code, "denied", `${caller} was let in`);
  }
  const listed = (await request("GET", "/v1/tools", undefined, { root, caller: "mcp" })).data?.map?.(x => x.name) || [];
  assert.ok(!listed.includes("recall.transcript"), "listed to MCP");
  for (const caller of ["cli", "local"]) {
    const r = await call("recall.transcript", { session: ID, limit: 2 }, { root, caller });
    assert.equal(r.data?.blocks.length, 2, `${caller}: ${JSON.stringify(r.error)}`);
  }
});

test("recall.transcript: a session with a transcript that no pass has indexed yet is read from disk", async t => {
  const root = await vyred(t);
  const fresh = "33333333-cccc-4000-8000-000000000003";
  const dir = path.join(root, "transcripts", "-home-alex-Work-harlow-legal");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${fresh}.jsonl`), [
    { type: "user", timestamp: "2026-09-05T10:00:00Z", cwd: "/home/alex/Work/harlow-legal", sessionId: fresh, message: { role: "user", content: "check the Harlow Legal intake form" } },
    { type: "assistant", timestamp: "2026-09-05T10:00:02Z", cwd: "/home/alex/Work/harlow-legal", sessionId: fresh, message: { id: "m1", role: "assistant", model: "m", content: [{ type: "text", text: "Looking now." }], usage: { input_tokens: 3, output_tokens: 4 } } },
  ].map(l => JSON.stringify(l)).join("\n") + "\n");
  const r = await call("recall.transcript", { session: fresh }, { root });
  assert.ok(r.data, JSON.stringify(r.error));
  assert.deepEqual(r.data.session, { id: fresh, cwd: "/home/alex/Work/harlow-legal", name: null, title: null });
  assert.deepEqual(r.data.blocks.map(b => `${b.seq}:${b.kind}`), ["0:user", "1:text", "1:turn"]);
  assert.equal(r.data.next, 0);
  for (const bad of ["33333333", "../../etc/passwd", `${fresh}/../x`]) {
    assert.equal((await call("recall.transcript", { session: bad }, { root })).error?.code, "not_found", bad);
  }
});
