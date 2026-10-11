// @ts-check
// memory.prompt is asked by the Switchboard for every chat turn. Without a verified person on the call, what does it put in front of a member's turn? (fictional data only)
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { open } from "../store/index.js";
import { HOME, seedRecall } from "../../test/fixtures/corpus.js";
import { tempHome } from "../../test/helpers.js";
import { fakeReachCall } from "../../test/fixtures/fake-reach.js";
import memory from "./index.js";

const W = `${HOME}/Work`;
const T0 = Date.parse("2026-08-01T09:00:00Z");
const WORLD = [{ id: "88888888-dddd-4000-8000-000000000001", cwd: `${W}/harlow-site`, start: T0, turns: [{ role: "user", text: "host it on netlify for now, free tier is fine" }] }, { id: "88888888-dddd-4000-8000-000000000002", cwd: `${W}/harlow-site`, start: T0 + 86_400_000 * 10, turns: [{ role: "user", text: "dana's IT guy says they already have a vercel team account with SSO. move harlow to vercel so they own it" }] }];

test("memory.prompt for a chat thread, asked by the Switchboard with no person on the call", async t => {
  const db = open(path.join(tempHome(t), "vyre.db")); t.after(() => db.close());
  seedRecall(db, WORLD);
  const tools = new Map();
  const ctx = { name: "memory", config: { me: { domains: ["riverastudio.com"] } }, paths: {}, store: { db, migrate: () => {} }, log: () => {}, events: { on: () => () => {}, emit: () => {}, since: () => [], prune: () => 0 },
    call: async (tool, input) => tool === "recall.search" ? { data: [] } : tool === "recall.thread" ? { data: { turns: [] } } : fakeReachCall(tool, input, { agents: [], projects: [] }), tool: (n, d) => tools.set(n, d), iqRunner: null, memoryRunner: null };
  const handle = await memory.start(ctx); t.after(() => handle.stop());
  await tools.get("memory.curate").run({}, { caller: "cli" });
  const rem = await tools.get("memory.remember").run({ text: "Sam's spouse is called Rhodri and the netlify password hint is the dog's name" }, { caller: "cli" }).catch(e => ({ error: String(e && e.message) }));
  assert.ok(rem && !rem.error);
  const r = await tools.get("memory.prompt").run({ prompt: "who is Rhodri and what is the netlify password hint", first: true, thread: "t1", person: true }, { caller: "module:threads", firstParty: true });
  assert.ok(!/Rhodri|password hint/.test(r.text) && !/netlify|vercel/.test(r.text), "a module asking for a chat thread with no project gets the brief only: nothing the owner remembered or said reaches another person's turn");
});
