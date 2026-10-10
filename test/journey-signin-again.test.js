// @ts-check
// G26 on a real vyred: a website login that ran out is one "sign in again" card on Now. The box writes it (approvals.items, kind signin); the app reads it with apps/app/src/real/signin-again.js, runs only the
// buttons it allows, says "still waiting" while the site is signed out, and the card is gone when the login works again.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { call } from "../core/daemon/client.js";
import { tempHome, present } from "./helpers.js";
import { fakeExtension, until } from "../local/hands-chrome-mac/fake-extension.js";
import { learnOperation } from "../lib/siteops/learn.js";
import * as F from "../lib/siteops/fixtures.js";
import { afterCheck, signinCards } from "../apps/app/src/real/signin-again.js";

const ORIGIN = "https://app.example.com";
const read = () => learnOperation({ name: "searchPeople", exchanges: F.pageRest("alpha corp"), exchanges2: F.pageRest("beta works"), examples: [{ query: "alpha corp" }, { query: "beta works" }], cookies: [{ name: "sid", value: F.SECRET_COOKIE }], storage: F.restStorage, trigger: { url: `${ORIGIN}/search?q={query}` } }).operation;
const send = () => learnOperation({ name: "sendMessage", kind: "send", exchanges: F.pageSend("ada-lovelace", "hello there friend"), exchanges2: F.pageSend("grace-hopper", "second text here"), examples: [{ recipient: "ada-lovelace", text: "hello there friend" }, { recipient: "grace-hopper", text: "second text here" }], cookies: [{ name: "sid", value: F.SECRET_COOKIE }], storage: F.restStorage, trigger: { url: `${ORIGIN}/inbox` } }).operation;

async function world(/** @type {any} */ t) {
  const root = tempHome(t);
  const sockDir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-site-"));
  t.after(() => fs.rmSync(sockDir, { recursive: true, force: true }));
  const sockPath = path.join(sockDir, "chrome.sock");
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "local", modules: { disable: ["hands"] }, vault: { keystore: "file" }, chrome: { sockPath, extensionOrigin: null } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const cli = (/** @type {string} */ tool, input = {}) => call(tool, input, { root, caller: "cli" });
  const model = (/** @type {string} */ tool, input = {}) => d.registry.call(tool, input, "mcp", { thread: "t-1" });
  const put = await cli("memory.site.put", { origin: ORIGIN, target: "origin", patch: { key: ORIGIN, ops: [{ name: "searchPeople", kind: "read", op: read() }, { name: "sendMessage", kind: "send", op: send() }] } });
  assert.equal(put.data && put.data.accepted, true, JSON.stringify(put));
  return { root, d, cli, model, sockPath };
}

/** @type {any[]} */ let seen = [];
const extension = (/** @type {string} */ sockPath, /** @type {any} */ over = {}) => fakeExtension(sockPath, { handler: (op, args, frame) => {
  seen.push({ op, args, trust: frame && frame.trust });
  if (over[op]) return over[op](args, frame);
  if (op === "tabs.use") return { tab: { id: 1, url: `${ORIGIN}/feed`, title: "Feed" } };
  if (op === "ops.call") return { ok: true, class: "ok", data: [{ name: `${args.inputs.query} one` }], op: args.op.name, status: 200 };
  if (op === "ops.check") return { ok: true, onSite: true, refs: { "session:csrf": true } };
  return { ok: true };
} });
const online = (/** @type {any} */ d) => until(async () => (await d.registry.call("chrome.status", {}, "cli")).data.connected);


test("a login that ran out is one card with the box's buttons; a check says still waiting; the card goes when the site answers again", async t => {
  const w = await world(t);
  await w.cli("connectors.site.connect", { site: ORIGIN, label: "LinkedIn" });
  let loggedIn = false;
  const x = await extension(w.sockPath, { "ops.call": (/** @type {any} */ a) => (loggedIn ? { ok: true, class: "ok", data: [{ name: "alpha one" }], op: a.op.name, status: 200 } : { ok: false, class: "auth", reason: "HTTP 401", next: "sign in again" }),
    "ops.check": () => (loggedIn ? { ok: true, onSite: true, refs: { "session:csrf": true } } : { ok: false, onSite: true, refs: { "session:csrf": false } }) });
  t.after(() => { x.sock.destroy(); });
  await online(w.d);
  const cards = async () => signinCards((await w.cli("approvals.items")).data);
  assert.deepEqual(await cards(), [], "nothing is wrong yet");
  await w.cli("connectors.operation.run", { connection: "linkedin", operation: "search_people", input: { query: { query: "gamma labs" } } });
  const [card] = await cards();
  assert.ok(card, "the lapsed login is a card");
  assert.equal(card.title, "Sign in to app.example.com again");
  assert.deepEqual(card.buttons.map(b => b.label), ["Check it now"]);
  assert.ok(!JSON.stringify(card).includes(F.SECRET_COOKIE) && !JSON.stringify(card).includes(F.CSRF), "no cookie and no token on the card");
  // the button runs the call the box named, and nothing else
  const press = async (/** @type {any} */ b) => (await w.cli(b.tool, b.input)).data;
  assert.equal(afterCheck(await press(card.buttons[0])), "Still waiting. Sign in on the site, then check again.");
  assert.equal((await cards()).length, 1, "still signed out: the card stays");
  loggedIn = true;
  await w.cli("connectors.operation.run", { connection: "linkedin", operation: "search_people", input: { query: { query: "gamma labs" } } });
  assert.deepEqual(await cards(), [], "the site answers again: the card is gone");
});

test("the app runs only the buttons it knows: a tool or a route the box names that it does not know is left out", () => {
  const items = { items: [{ id: "connectors:x", kind: "signin", title: "Sign in to x.test again", at: 1, answers: [
    { label: "Check it now", tool: "connectors.connection.check", input: { id: "x" } },
    { label: "Wipe it", tool: "vault.remove", input: { id: "x" } },
    { label: "Open the computer's screen", open: "/u/glass/kit" },
    { label: "Go away", open: "https://evil.example/" },
  ] }, { id: "other", kind: "approval", title: "not mine" }] };
  const [c] = signinCards(items);
  assert.deepEqual(c.buttons.map(b => b.label), ["Check it now", "Open the computer's screen"]);
  assert.equal(afterCheck({ light: "green" }), "");
});
