// @ts-check
// What the registry itself does with github's outward tools: merge, review and open declare
// reach "asked", so an agent's unasked call is refused before the tool runs (no request ever
// leaves), while the person's own call goes through to the tool. Boots a real vyred in a temp home.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { store as accountStore, projectStore } from "./accounts.js";
import { tempHome, present } from "../../test/helpers.js";

test("github.project.pr.open / .merge / .review: reach asked - an agent is refused not_asked, the person's own call reaches the tool", async t => {
  let daemon = null;
  const root = tempHome(t, { stop: () => daemon && daemon.stop() });
  daemon = await start({ root, presence: present, log: () => {} });
  const calls = [
    ["github.project.pr.open", { project: "app", title: "t", head: "vyre/x" }],
    ["github.project.pr.merge", { project: "app", pr: 7 }],
    ["github.project.pr.review", { project: "app", pr: 7, event: "APPROVE" }],
  ];
  for (const [tool, input] of calls) {
    const agent = await daemon.registry.call(tool, input, "mcp:agent:kit");
    assert.equal(agent.error && agent.error.code, "not_asked", `${tool} for an agent`);
    const person = await daemon.registry.call(tool, input, "cli");
    assert.notEqual(person.error && person.error.code, "not_asked", `${tool} for the person`);
    assert.equal(person.error && person.error.code, "not_found", "reached the tool, which has no such project");
  }
  // A read is open to the agent.
  const read = await daemon.registry.call("github.project.pr.get", { project: "app", pr: 7 }, "mcp:agent:kit");
  assert.notEqual(read.error && read.error.code, "not_asked");
});

test("github's hosted MCP row is one the real hub accepts, and it refuses the same item aimed at another host", async t => {
  let daemon = null;
  const root = tempHome(t, { stop: () => daemon && daemon.stop() });
  daemon = await start({ root, presence: present, log: () => {} });
  const row = { name: "github", transport: "http", url: "https://api.githubcopilot.com/mcp/", auth: { type: "bearer", item: "github-home", field: "token" }, tools: { deny: ["create_or_update_file", "push_files", "delete_file"] } };
  const ok = await daemon.registry.call("mcp.add", row, "module:github");
  assert.equal(ok.error, undefined, JSON.stringify(ok.error));
  assert.equal(ok.data.name, "github");
  const elsewhere = await daemon.registry.call("mcp.add", { ...row, name: "github-evil", url: "https://evil.example/mcp/" }, "module:github");
  assert.match(String(elsewhere.error && elsewhere.error.message), /goes only to api\.githubcopilot\.com/);
});

test("the person's yes binds the PR: with no intent an agent's merge is not_asked, the PR said yes to runs, a different PR or another thread is refused (real registry, real vault)", async t => {
  let daemon = null;
  const root = tempHome(t, { stop: () => daemon && daemon.stop() });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" } }));
  daemon = await start({ root, presence: present, log: () => {} });
  const reg = daemon.registry;
  // A connected account with its token in the vault, and a project whose primary repo is alex/app.
  const put = await reg.call("vault.put", { name: "github-home", kind: "pat", fields: { token: "test-token-not-real" } }, "cli"); assert.ok(put.data, JSON.stringify(put.error));
  assert.equal((await reg.call("vault.grant", { name: "github-home", module: "github" }, "cli")).data.grant.status, "active");
  accountStore(reg.deps.db).put({ name: "home", login: "alex", avatar_url: null, item: "github-home" }, Date.now());
  projectStore(reg.deps.db).put({ project: "app", account: "home", full_name: "alex/app", default_branch: "main", home: "/tmp/none" }, Date.now());
  const requests = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async (url, opts = {}) => {
    requests.push(`${opts.method || "GET"} ${new URL(String(url)).pathname}`);
    return { ok: true, status: 200, text: async () => JSON.stringify({ merged: true, sha: "abc", message: "ok" }) };
  });
  t.after(() => { globalThis.fetch = realFetch; });
  const agent = (input, thread = "t-1") => reg.call("github.project.pr.merge", input, "mcp:agent:kit", { thread, agent: "kit", granted: ["app"] }); // granted: what the daemon reads from the agent's stored row

  assert.equal((await agent({ project: "app", pr: 12 })).error.code, "not_asked", "no intent, no merge");
  assert.deepEqual(requests, [], "nothing reached GitHub");
  // The person's turn in thread t-1 said "merge it", about PR 12 of alex/app: one composite key.
  const said = await reg.call("vault.said.record", { thread: "t-1", said: "m-1", kind: "act_out", to: ["github.project.pr.merge:alex/app#12"], what: "merge alex/app#12" }, "module:sessions");
  assert.ok(said.data && said.data.id, JSON.stringify(said));
  assert.equal((await agent({ project: "app", pr: 40 })).error.code, "not_asked", "a different PR is refused");
  assert.equal((await agent({ project: "app", pr: 12 }, "t-2")).error.code, "not_asked", "another thread is refused");
  assert.deepEqual(requests, [], "still nothing reached GitHub");
  const ok = await agent({ project: "app", pr: 12 });
  assert.equal(ok.error, undefined, JSON.stringify(ok.error));
  assert.equal(ok.data.merged, true);
  assert.deepEqual(requests, ["PUT /repos/alex/app/pulls/12/merge"]);
  assert.equal((await agent({ project: "app", pr: 12 })).error.code, "not_asked", "a plain yes is used up by the merge it covered");
  assert.equal(requests.length, 1, "and the second try never reached GitHub");
});
