// @ts-check
// Group chat against a REAL daemon (not the sample world): a chat made with an agent, then the three lists the composer needs, filled from the box's own answers through the app's own builders:
//   @  the chat's members and agents  (work.chat.get, records.actors, agents.list -> membersFrom, peopleFor)
//   #  the records the person may read (records.types, records.list -> recordPicks)
//   the models a slot can switch to  (providers.list -> modelChoices, threads.chat-switch through switchCall)
// The daemon runs in a temp home with the fake claude (core/sessions/testing/boot.js). Needs the One Chat tools (work.chat.*, threads.chat-switch), which a tree without chat's server does not have: it says so.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../../../../core/daemon/index.js";
import { asOwner, tempHome, present } from "../../../../test/helpers.js";
import { FAKE, until } from "../../../../core/sessions/testing/boot.js";
import { membersFrom, slotNames } from "./members.js";
import { modelChoices, peopleFor, recordPicks, switchCall } from "./real-composer.js";
import crypto from "node:crypto";
import { createRing, holdersOf } from "../../../../lib/chat-keys.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
process.env.VYRE_SESSION_SANDBOX_OFF = "1";

test("group chat on a real daemon: @ lists the chat's members and agents, # lists the person's records, and a slot's model switch is a call the box takes", { timeout: 120_000 }, async (t) => {
  const root = tempHome(t);
  const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, FAKE_CLAUDE_TRANSCRIPTS: process.env.FAKE_CLAUDE_TRANSCRIPTS };
  const transcripts = path.join(root, "transcripts");
  Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", FAKE_CLAUDE_TRANSCRIPTS: transcripts });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  fs.mkdirSync(transcripts);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [transcripts], sessions: { install: false, thread_socket: "on" } }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  asOwner(d, root);
  t.after(() => d.stop());
  /** @param {string} tool @param {any} [input] */
  const call = async (tool, input = {}) => d.registry.call(tool, input, "cli");
  const data = async (/** @type {string} */ tool, /** @type {any} */ input) => { const r = await call(tool, input); assert.ok(!r.error, `${tool}: ${JSON.stringify(r.error)}`); return r.data; };
  if ((await call("work.chat.list", {})).error?.code === "no_such_tool") return t.skip("this tree has no One Chat server (work.chat.*)");

  // the person's own: an agent, a chat with it, and records of a type with a sealed field
  await data("agents.create", { name: "kit", kind: "assistant", instructions: "Kit keeps the intake tidy." });
  // the app starts a chat with a ring its device made (a chat with a person in it is never in the clear): a device's agree point, its ring, then the start
  const dev = crypto.createECDH("prime256v1"); dev.generateKeys();
  const chatId = `chat_${crypto.randomUUID()}`;
  const ring = createRing(chatId, holdersOf([{ device: "dev_test", agree: dev.getPublicKey().toString("base64url") }]));
  const made = await data("work.chat.create", { title: "Intake", id: chatId, ring: ring.doc });
  const chat = String(made.id ?? made.chat?.id ?? made.chat);
  assert.match(chat, /^chat_/);
  await data("records.define", { diff: { add_types: [{ name: "matter", label: "Matter", fields: [{ name: "title", kind: "text", label: "Title" }, { name: "ssn", kind: "sealed", label: "SSN" }] }] } });
  await data("records.create", { type: "matter", data: { title: "Northwind lease dispute" } });
  await data("records.create", { type: "matter", data: { title: "Reyes probate" } });

  // a model joins a chat when it is first asked in it: the first message goes through the stream, as the app sends it
  const sent = await call("stream.send", { chat, text: "Hello, who is here?", message: "0190c3f2-aaaa-4abc-8def-000000000001", surface: "deck" });
  assert.ok(!sent.error, `stream.send: ${JSON.stringify(sent.error)}`);
  await until(async () => ((await call("work.chat.get", { chat })).data?.slots ?? []).length > 0, "the model's slot appears in the chat", 60_000);

  // @ : the chat's own members, then the space's actors and the person's agents
  const got = await data("work.chat.get", { chat });
  const actors = await data("records.actors", {});
  const agents = await data("agents.list", {});
  const me = String((await data("records.me", {})).person ?? "");
  const members = membersFrom(got, actors, me);
  assert.ok(members.some((m) => m.id === `person:${me}` && m.name === "You"), JSON.stringify(members));
  // the model the chat was made with is a slot, and the chip that switches it is named for it
  assert.equal(slotNames(got).length, 1, JSON.stringify(got.slots));
  const people = peopleFor({ actors, agents, viewer: me, here: members.filter((m) => m.id !== `person:${me}`).map((m) => ({ name: m.name, family: m.family })) });
  assert.ok(people.some((p) => p.name === "kit" && p.family === "assistant"), `@ lists kit (the person's own assistant): ${JSON.stringify(people)}`);

  // # : the records the person may read, named by title, with the sealed ones marked
  const types = (await data("records.types", {})).types ?? (await data("records.types", {}));
  const typeList = Array.isArray(types) ? types : [];
  const matter = typeList.find((x) => x.name === "matter");
  assert.ok(matter, `the type is listed: ${JSON.stringify(typeList.map((x) => x.name))}`);
  const rows = await data("records.list", { type: "matter" });
  const rowList = Array.isArray(rows) ? rows : rows.rows ?? rows.records ?? [];
  assert.equal(rowList.length, 2, JSON.stringify(rows).slice(0, 300));
  const picks = recordPicks({ types: [matter], byType: { matter: rowList } }, (/** @type {any} */ def, /** @type {any} */ rec) => String(rec.data?.title ?? rec.id));
  assert.deepEqual(picks.map((p) => p.name).sort(), ["Northwind lease dispute", "Reyes probate"]);

  // the models: providers.list builds the choices, and a switch is a call the box takes (it may refuse for want of a signed-in account, never as an unknown tool or a bad input)
  const prov = await data("providers.list", {});
  const { models } = modelChoices(prov, { provider: "claude" });
  assert.ok(Array.isArray(models));
  const slot = (got.slots || [])[0]?.slot;
  const sw = switchCall(chat, "claude||sonnet", prov, { provider: "claude" }, slot);
  assert.ok(sw && sw.tool === "threads.chat-switch" && sw.input.chat === chat);
  const out = await call(sw.tool, sw.input);
  assert.ok(!out.error || !["no_such_tool", "bad_input"].includes(String(out.error.code)), `threads.chat-switch: ${JSON.stringify(out.error)}`);
});
