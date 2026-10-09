// The Design and Module MCP: a few tokens to list, a screen checked with the fix named, a picture of a screen drawn by the app, a proposal sent to the box, and the module kit behind four tools.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handle, callTool, TOOLS } from "./design.js";
import { findChrome } from "../../lib/design/render.js";

const screen = { v: 2, title: "Today", layout: { col: [{ block: "k" }, { block: "l" }] }, blocks: { k: { type: "stats" }, l: { type: "list" } } };

test("design MCP: the tool list is small enough to leave on", async () => {
  const list = (await handle({ id: 1, method: "tools/list" })).tools;
  assert.equal(list.length, 8);
  const tokens = Math.round(JSON.stringify(list).length / 4);
  assert.ok(tokens <= 700, `tools/list is about ${tokens} tokens`);
  const init = await handle({ id: 0, method: "initialize", params: {} });
  assert.match(init.instructions, /design_catalogue/);
  assert.ok(Math.round(JSON.stringify(init).length / 4) <= 200);
});

test("design MCP: the catalogue and the checker answer in few words and name the fix", async () => {
  const idx = (await callTool("design_catalogue")).content[0].text;
  assert.ok(Math.round(idx.length / 4) <= 1300, `the index is about ${Math.round(idx.length / 4)} tokens`);
  assert.equal((await callTool("design_validate", { screen })).content[0].text, "ok");
  const bad = await callTool("design_validate", { screen: { ...screen, blocks: { k: { type: "stats", props: { color: "red" } }, l: { type: "list" } } } });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /props\.color is not a prop of stats; use tone/);
  assert.ok(bad.content[0].text.length < 400, "a failure stays short");
});

test("design MCP: propose goes to the box tool and says what it reads and runs; without a box it says so", async () => {
  /** @type {any[]} */ const seen = [];
  const box = async (/** @type {string} */ tool, /** @type {any} */ input) => { seen.push([tool, input.id]); return { data: { proposal: { id: 7, status: "pending", replaces: false, uses: { reads: ["m.x"], runs: [] } } } }; };
  const r = await callTool("design_propose", { id: "today", screen, why: "a start" }, { box });
  assert.deepEqual(seen, [["design.propose", "today"]]);
  assert.match(r.content[0].text, /proposal 7 sent to the owner; reads m\.x; runs nothing/);
  assert.equal((await callTool("design_propose", { id: "today", screen, why: "x" })).isError, true);
  assert.equal((await callTool("design_propose", { id: "today", screen: { v: 2, layout: { block: "z" }, blocks: {} }, why: "x" }, { box })).isError, true, "an invalid screen never leaves");
});

test("design MCP: the module tools run the kit and install only stages", async () => {
  /** @type {string[][]} */ const ran = [];
  const cli = async (/** @type {string[]} */ args) => { ran.push(args); return { code: args[1] === "check" && args[2] === "/bad" ? 1 : 0, out: args[1] === "check" && args[2] === "/bad" ? "views.today.screen: blocks.k.type is not a block" : "ok" }; };
  await callTool("module_scaffold", { name: "bakery", dir: "/tmp/x" }, { cli });
  await callTool("module_test", { dir: "/m" }, { cli });
  assert.deepEqual(ran, [["module", "new", "bakery", "--dir", "/tmp/x"], ["module", "test", "/m"]]);
  const staged = await callTool("module_install", { dir: "/m" }, { cli });
  assert.match(staged.content[0].text, /the owner's act: they run  vyre module add \/m/);
  assert.equal(ran.at(-1)?.[1], "check", "install never runs `add`");
  const refused = await callTool("module_install", { dir: "/bad" }, { cli });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /not a block/);
  assert.ok(TOOLS.every(t => t.name.startsWith("design_") || t.name.startsWith("module_")));
});

// The picture: needs a Chrome and a web export of the app (PICTURE_DIST, with the app's /gallery route); skipped where there is neither, run on the test box.
test("design MCP: a screen is drawn by the app itself and comes back as a picture", { skip: !findChrome() || !process.env.PICTURE_DIST ? "no Chrome or PICTURE_DIST" : false }, async () => {
  const dist = /** @type {string} */ (process.env.PICTURE_DIST);
  const srv = http.createServer((req, res) => { let f = path.join(dist, decodeURIComponent((req.url || "/").split("?")[0]).replace(/^\/app/, "") || "/"); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(dist, "index.html"); res.writeHead(200); fs.createReadStream(f).pipe(res); }).listen(0);
  try {
    const r = await callTool("design_render", { screen, surface: "phone", theme: "dark" }, { appUrl: `http://127.0.0.1:${/** @type {any} */ (srv.address()).port}/app` });
    assert.equal(r.isError, undefined, JSON.stringify(r.content[0]));
    assert.match(r.content[0].text, /390 wide; sample data in k, l/);
    assert.equal(r.content[1].mimeType, "image/png");
    assert.ok(Buffer.from(r.content[1].data, "base64").length > 3000, "a real picture");
  } finally { srv.close(); }
});
