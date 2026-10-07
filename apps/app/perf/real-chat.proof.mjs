// The chat screen on the real stream, end to end: a real vyred (fake claude), the exported web app
// served beside it, and headless Chromium. Not part of `npm test` (the name is .proof.mjs).
//   node --test apps/app/perf/real-chat.proof.mjs        (run from the repo root, after `npm run export:web` in apps/app)
// Needs `playwright` resolvable (PW_FROM, default $HOME/shots/). Shots go to SHOTS (perf/shots/chat).
//
// The page's tool calls reach vyred through a small proxy here that does what the daemon's HTTP door does
// for a signed-in person (the call is the deck's, `as` is the viewer); the stream's WebSocket is the
// daemon's own upgrade handler. Everything past that is the app's real code path.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { SCRATCH } from "../../../test/scratch.mjs";
import { start } from "../../../core/daemon/index.js";
import { call } from "../../../core/daemon/client.js";
import { serveApp } from "../../../core/daemon/app.js";
import { tempHome, present } from "../../../test/helpers.js";
import { until, FAKE } from "../../../core/sessions/testing/boot.js";
import { connect, wsDuplex } from "../../../core/stream/client.js";

const require = createRequire(process.env.PW_FROM || path.join(process.env.HOME, "shots/"));
const { chromium } = require("playwright");
const SHOTS = path.resolve(process.env.SHOTS || "perf/shots/chat");
const ALEX = "person:alex", KIT = "assistant:kit", JUNO = "assistant:juno", GROUP = "grp-harlow";
const REPLY_WORDS = Number(process.env.REPLY_WORDS || 700);

test("chat screen on the real stream: send, mention, stream, drop the network, no loss, no repeat", { timeout: 240_000 }, async (t) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  let daemon = null;
  const root = tempHome(t, { stop: () => daemon && daemon.stop() });
  const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, FAKE_CLAUDE_TRANSCRIPTS: process.env.FAKE_CLAUDE_TRANSCRIPTS };
  const transcripts = path.join(root, "transcripts");
  Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", FAKE_CLAUDE_TRANSCRIPTS: transcripts });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  fs.mkdirSync(transcripts);
  const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-work-")));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [transcripts], sessions: { install: false }, files: { roots: [work] }, term: { shell: "/bin/sh" } }));
  daemon = await start({ root, presence: present, log: () => {} });
  const tool = (name, input, caller = "deck") => call(name, input, { root, caller, timeout: 20_000 });

  // The box's door for the page: tools as the deck for alex, the stream's upgrade, the app's files.
  const sockets = new Set();
  const calls = [];
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://x");
    if (req.method === "POST" && url.pathname.startsWith("/v1/tools/")) {
      let raw = ""; for await (const c of req) raw += c;
      const name = decodeURIComponent(url.pathname.slice("/v1/tools/".length));
      const input = raw ? JSON.parse(raw) : {};
      const r = await tool(name, { ...input, as: ALEX });
      calls.push({ name, key: req.headers["idempotency-key"] || null, ok: !r.error, text: input.text });
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(r)); return;
    }
    if (url.pathname === "/v1/health") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: { ok: true } })); return; }
    if (url.pathname === "/v1/events/stream") { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(": ok\n\n"); return; }
    if (url.pathname.startsWith("/app")) { serveApp(res, url.pathname); return; }
    res.writeHead(404); res.end();
  });
  srv.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", "http://x");
    const m = /^\/v1\/streams\/([a-z-]+)\/([a-z-]+)$/.exec(url.pathname);
    const u = m && daemon.registry.upgrades.get(`${m[1]}/${m[2]}`);
    if (!u) { socket.end("HTTP/1.1 404 Not Found\r\n\r\n"); return; }
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    u.handler(req, socket, head, { caller: "deck", url });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", () => r(undefined)));
  const origin = `http://127.0.0.1:${srv.address().port}`;
  t.after(() => { for (const s of sockets) s.destroy(); srv.closeAllConnections(); srv.close(); });

  // The group: alex (the viewer), chris, kit and juno, made by a first message from chris that names nobody.
  const members = { assistants: [{ id: KIT, cwd: work }, { id: JUNO, cwd: work }], people: [ALEX], default: KIT };
  const first = (await tool("stream.send", { session: GROUP, text: "chris here: the bakery menu is due Friday", as: "person:chris", ...members })).data;
  assert.deepEqual(first.routed, [], "nobody is asked by that");

  const browser = await chromium.launch({ args: ["--use-mock-keychain", "--password-store=basic"] });
  t.after(() => browser.close());
  const log = [];
  const results = {};
  for (const width of [390, 1280]) {
    const ctx = await browser.newContext({ viewport: { width, height: width < 600 ? 800 : 860 }, colorScheme: "dark" });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
    await page.goto(`${origin}/app/session/${GROUP}`, { waitUntil: "load" });
    await page.getByText("the bakery menu is due Friday").first().waitFor({ timeout: 30000 });
    await page.screenshot({ path: path.join(SHOTS, `real-${width}-01-open.png`) });
    // The participant list and names come from participant-joined frames.
    const header = await page.evaluate(() => document.body.textContent || "");
    for (const n of ["Chris joined", "Alex joined", "Kit joined", "Juno joined"]) assert.ok(header.includes(n), `${n}: names come from the participant frames`);
    assert.ok(!/person:|assistant:/.test(header), "no raw ids on screen");

    // Send, mentioning juno.
    const tok = (i) => `x${width}_${i}`;
    const words = Array.from({ length: REPLY_WORDS }, (_, i) => tok(i)).join(" ");
    const text = `@juno list the pastries ${width}: ${words}`;
    const box = page.getByRole("textbox").last();
    await box.click();
    await box.fill(text);
    await page.getByRole("button", { name: /^(Send|Queue message)$/ }).last().click();
    // The user message shows, and juno's reply starts streaming.
    await page.getByText(`list the pastries ${width}`).first().waitFor({ timeout: 20000 });
    try { await until(async () => (await page.evaluate(() => document.body.textContent || "")).includes("echo: @juno"), "juno's reply to begin", 30000); }
    catch (e) { await page.screenshot({ path: path.join(SHOTS, `real-${width}-fail.png`) }); console.log(JSON.stringify({ calls, errors, body: (await page.locator("body").innerText()).slice(0, 1500) })); throw e; }
    await page.screenshot({ path: path.join(SHOTS, `real-${width}-02-streaming.png`) });

    // Drop the network mid-reply: the browser goes offline and the box's sockets are cut.
    await ctx.setOffline(true);
    for (const s of sockets) s.destroy();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(SHOTS, `real-${width}-03-offline.png`) });
    // A second message while offline sits in the outbox.
    await box.fill(`@kit second thing ${width}`);
    await page.getByRole("button", { name: /^(Send|Queue message)$/ }).last().click();
    await page.waitForTimeout(500);
    await ctx.setOffline(false);

    // Everything settles: both replies end, in order, once.
    await until(async () => {
      const t = await page.evaluate(() => document.body.textContent || "");
      return t.split(tok(REPLY_WORDS - 1)).length - 1 >= 2 && t.includes(`echo: @kit second thing ${width}`);
    }, "juno's whole reply on screen after the network came back", 90000);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(SHOTS, `real-${width}-04-restored.png`) });

    // The reply is painted, not only in the DOM: its text is visible and it has a real height.
    const reply = page.getByText(new RegExp(`echo: @juno list the pastries ${width}`)).first();
    await reply.scrollIntoViewIfNeeded();
    assert.ok(await reply.isVisible(), "juno's reply is visible");
    const vis = await reply.evaluate((el) => ({ h: el.getBoundingClientRect().height, text: (el.innerText || "").length }));
    assert.ok(vis.h > 40 && vis.text > 1000, `juno's reply is painted whole (${JSON.stringify(vis)})`);
    await page.screenshot({ path: path.join(SHOTS, `real-${width}-05-reply.png`) });
    const body = await page.evaluate(() => document.body.textContent || "");
    const once = (needle) => body.split(needle).length - 1;
    results[width] = { errors: errors.slice(0, 3), wordsOnce: once(tok(REPLY_WORDS - 1)), secondOnce: once(`second thing ${width}`) };
    log.push({ width, ...results[width] });
    assert.equal(once(tok(REPLY_WORDS - 1)), 2, "the last word shows in the sent message and in juno's one reply, nowhere else");
    assert.equal(once(`echo: @kit second thing ${width}`), 1, "kit's reply to the message sent offline shows once");
    assert.equal(once(`@kit second thing ${width}`), 2, "the offline message shows once as sent and once in kit's echo");
    await ctx.close();
  }

  // The log, from the box: a gapless cursor, every message once, each reply's words in order and once.
  const frames = [];
  const c = connect({ open: async ({ from }) => { const o = (await tool("stream.open", { session: GROUP, from, as: ALEX })).data; return wsDuplex(`ws://127.0.0.1:${srv.address().port}${o.path}`); }, onFrame: (f) => frames.push(f), backoff: { base: 5, cap: 40 } });
  t.after(() => c.close());
  await until(() => frames.length > 5, "the log", 20000);
  await new Promise((r) => setTimeout(r, 800));
  let next = 1;
  for (const f of frames) { assert.equal(f.cur - (f.span || 1) + 1, next, "gapless"); next = f.cur + 1; }
  const users = frames.filter((f) => f.type === "session.user-message");
  const ids = users.map((f) => f.data.message);
  assert.equal(new Set(ids).size, ids.length, "each message once");
  const replies = new Map();
  for (const f of frames) if (f.type === "session.text-delta" && !f.data.reasoning) replies.set(f.data.message, (replies.get(f.data.message) || "") + f.data.text);
  const done = frames.filter((f) => f.type === "session.text-done").map((f) => f.data.message);
  assert.equal(new Set(done).size, done.length, "each reply ends once");
  for (const width of [390, 1280]) {
    const long = [...replies.values()].filter((x) => x.includes(`x${width}_${REPLY_WORDS - 1}`));
    assert.equal(long.length, 1, `one long reply at ${width}`);
    assert.deepEqual(long[0].match(/x\d+_\d+/g), Array.from({ length: REPLY_WORDS }, (_, i) => `x${width}_${i}`), "the words are in order, none lost, none repeated");
  }
  console.log(JSON.stringify({ proof: "real-chat", log, calls: calls.map((c) => `${c.name}${c.key ? "+key" : ""}${c.ok ? "" : " FAILED"}`), frames: frames.length, head: next - 1, users: ids.length, replies: replies.size }));
});
