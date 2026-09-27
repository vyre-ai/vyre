// @ts-check
// A Mac's person session on its box (core/link/mac.js link.signin, core/presence/person.js): the
// Mac's command line and Capsule answer asks on the box only after the person signs the Mac in on
// the box's own page, and only for the person's own callers. Both vyreds are real, and the box's
// tailnet goes through its real router.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { pair, OWNER, MAC } from "./link-harness.js";
import { HUMAN_ONLY } from "../core/presence/index.js";

/** Every human-only tool asks, and any call counts as proved: what is refused below is about the session. */
const proving = {
  required: (tool, def) => HUMAN_ONLY.has(tool) || Boolean(def && def.presence),
  verify: async () => ({ ok: true, method: "passkey", keyId: "k1" }),
  challenge: async () => ({ error: { code: "bad_input", message: "no challenges here" } }),
};

const get = url => new Promise((resolve, reject) => {
  http.get(url, { agent: false }, res => { let b = ""; res.setEncoding("utf8"); res.on("data", c => (b += c)); res.on("end", () => resolve({ status: res.statusCode, body: b })); }).on("error", reject);
});

test("link: a Mac answers on the box only once the person signs it in, and only for the person's callers", async t => {
  const s = await pair(t, { router: true, boxPresence: proving });

  // Not signed in: the person's action never rides the link, whoever asks.
  const before = await s.macCall("link.call", { tool: "agents.create", input: { name: "kit" } });
  assert.equal(before.error && before.error.code, "person_session_required", JSON.stringify(before));

  // Sign in: the Mac gives the address of the box's page, with a PKCE challenge and its loopback.
  const started = await s.macCall("link.signin");
  assert.ok(!started.error, JSON.stringify(started.error));
  const url = new URL(started.data.url);
  assert.equal(url.pathname, "/person/signin");
  const cc = String(url.searchParams.get("cc"));
  const back = String(url.searchParams.get("return"));
  assert.match(back, /^http:\/\/127\.0\.0\.1:\d+\/cb\/[\w-]{16,}$/);
  assert.equal((await s.macCall("link.signin", {}, "mcp")).error.code, "denied", "a model cannot start it");

  // The page, in the person's browser on the Mac: the passkey, then the code goes to the loopback.
  const page = await s.boxCall("presence.person.start", { cc, return: back }, `tailnet:${OWNER}`, { peer: MAC });
  assert.ok(!page.error, JSON.stringify(page.error));
  assert.match(page.data.redirect, /^http:\/\/127\.0\.0\.1:\d+\/cb\/[\w-]+\?code=/);
  // Another loopback path is not a sign-in address.
  assert.equal((await s.boxCall("presence.person.start", { cc, return: "http://127.0.0.1:9/elsewhere" }, `tailnet:${OWNER}`, { peer: MAC })).error.code, "denied");
  const landed = await get(page.data.redirect);
  assert.equal(landed.status, 200, landed.body);
  assert.ok((await s.macCall("link.status")).data.signedIn);
  await assert.rejects(get(page.data.redirect), /ECONNREFUSED|hang up/, "the loopback closes after one use");

  // Signed in: the person's terminal and Capsule reach the box's person-only tools.
  const made = await s.macCall("link.call", { tool: "agents.create", input: { name: "kit" } }, "cli");
  assert.ok(!made.error, JSON.stringify(made.error));
  assert.ok((await s.boxCall("agents.list")).data.some(a => a.name === "kit"));
  // A model or a module on the Mac never carries the session.
  for (const caller of ["mcp", "mcp:agent:kit", "anonymous", "module:planner"]) {
    const r = await s.macCall("link.call", { tool: "agents.update", input: { name: "kit", description: "x" } }, caller);
    assert.equal(r.error && r.error.code, "person_session_required", caller);
  }
  // Human-only still needs the person's passkey on the box.
  assert.equal((await s.macCall("link.call", { tool: "vault.reveal", input: { name: "northwind-mail" } })).error.code, "person_session_required");
  // The box lists the Mac's session, pinned to the Mac's node.
  const list = (await s.boxCall("presence.person.sessions")).data.sessions;
  assert.deepEqual(list.map(x => [x.kind, x.node]), [["bearer", MAC.stableId]]);

  // Signing out ends it on the box too.
  assert.equal((await s.macCall("link.signout")).data.signedOut, true);
  assert.equal((await s.boxCall("presence.person.sessions")).data.sessions.length, 0);
  assert.equal((await s.macCall("link.call", { tool: "agents.create", input: { name: "juno" } })).error.code, "person_session_required");
});
