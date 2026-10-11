// @ts-check
// One index: a skill the caller may use is found by tools_find beside the registry tools, filed under its group, called by name, and a call reads the skill.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { start } from "../core/daemon/index.js";
import { tempHome } from "./helpers.js";
import { skillEntries, SKILL_GROUP } from "../lib/tools-extras.js";
import { indexOf, find, shapeFind } from "../harness/mcp/core-tools.js";

const SKILLS = [
  { id: "personal/keep-a-password-out-of-a-file", name: "Keep a password out of a file", description: "Use when a secret would be written into a file or a command: put it in the Vault and refer to it." },
  { id: "project/northwind/intake-a-new-matter", name: "Intake a new matter", description: "Use when a new client matter comes in: open the record, link the client, set the first task." },
  { id: "personal/other", name: "Keep a password out of a file", description: "A second skill with the same name." },
];
const REGISTRY = [
  { name: "system_echo", tool: "system.echo", description: "Echo text back.", input: { type: "object", properties: { text: { type: "string" } } } },
  { name: "vault_list", tool: "vault.list", description: "List the secrets in the Vault.", input: { type: "object", properties: {} } },
];

test("skills become catalog entries with a group, unique names, and a route that reads the skill by id", () => {
  const { catalog, routes } = skillEntries(SKILLS, new Set(["skill_other"]));
  assert.equal(catalog.length, 3);
  assert.equal(new Set(catalog.map(c => c.name)).size, 3, "two skills with one name get two names");
  for (const c of catalog) { assert.equal(c.group, SKILL_GROUP); assert.equal(c.tool, "skills.get"); assert.ok(/^[A-Za-z0-9_-]{1,64}$/.test(c.name)); }
  assert.deepEqual(routes.get(catalog[0].name), { tool: "skills.get", fixed: { id: "personal/keep-a-password-out-of-a-file" } });
  assert.deepEqual(skillEntries([{ name: "no id" }, null], new Set()).catalog, [], "a row without an id is skipped");
});

test("tools_find returns a skill beside the tools, with its group and a ready call, and still returns the tools", () => {
  const { catalog } = skillEntries(SKILLS, new Set());
  const index = indexOf([...REGISTRY, ...catalog]);
  const shaped = shapeFind(find(index, "a new client matter came in, what do I do", 5));
  const top = shaped.tools[0];
  assert.match(top.name, /^skill_intake_a_new_matter/);
  assert.equal(top.group, SKILL_GROUP);
  assert.equal(top.call.tool, "tools_call");
  assert.equal(top.call.arguments.tool, top.name);
  assert.ok(find(indexOf([...REGISTRY, ...catalog]), "list my secrets in the vault", 3).some(f => f.name === "vault_list"), "a registry tool is still found");
});

test("on a real daemon: tools_find returns a skill the caller may use, and calling it by name reads the whole SKILL.md; a skill of another level is not offered", async t => {
  const root = tempHome(t);
  // an account-level skill is the person's own: a plain MCP caller with no person behind it is not offered it
  const dir = path.join(root, "learned", "account", "skills", "chase-late-invoices");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: chase-late-invoices\ndescription: Use when a client invoice is overdue and needs a polite payment reminder\n---\n\n# Chase late invoices\n\nSTEP-ONE.\n");
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const env = { ...process.env, VYRE_HOME: root };
  delete env.VYRE_SOCKET; delete env.VYRE_AGENT; delete env.VYRE_HUB_CHILD;
  const child = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "harness", "mcp", "server.js")], { env, stdio: ["pipe", "pipe", "inherit"] });
  t.after(() => child.kill());
  const got = new Map();
  readline.createInterface({ input: /** @type {any} */ (child.stdout) }).on("line", l => { try { const m = JSON.parse(l); got.set(m.id, m); } catch {} });
  const ask = async (id, method, params = {}) => {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    for (let i = 0; i < 300 && !got.has(id); i++) await new Promise(r => setTimeout(r, 50));
    return got.get(id);
  };
  await ask(1, "initialize", { protocolVersion: "2025-06-18" });
  const every = r => { const f = JSON.parse(r.result.content[0].text); return [...f.tools, ...(f.also || [])]; };
  const full = JSON.parse((await ask(2, "tools/call", { name: "tools_find", arguments: { query: "skill use the vault" } })).result.content[0].text).tools.find(x => /^skill_use_the_vault/.test(x.name));
  assert.ok(full, "the Vault skill is found beside the registry tools");
  assert.ok(full.group === "skills.use" && full.call.tool === "tools_call", "a skill in the full answer carries its group and a ready tools_call");
  const hit = full;
  const read = await ask(4, "tools/call", { name: "tools_call", arguments: { tool: hit.name, arguments: {} } });
  assert.ok(!read.result.isError, JSON.stringify(read.result).slice(0, 300));
  assert.match(JSON.stringify(read.result), /vyre\/use-the-vault/, "calling the entry returns the skill (skills.get with its id)");
  assert.ok(!every(await ask(5, "tools/call", { name: "tools_find", arguments: { query: "chase late invoices payment reminder", limit: 10 } })).some(x => /chase_late_invoices/.test(x.name)), "an account-level skill is not offered to a caller with no person");
});
