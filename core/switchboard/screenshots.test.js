// @ts-check
// A screenshot the browser tool took is shown in the chat (0.3.3 G25): the Switchboard keeps the image a screenshot tool's result carries as an artifact. Only a screenshot tool's images (not every image a tool reads),
// and a real daemon with the fake claude proves the artifact exists afterwards.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { translate } from "./translate.js";
import { boot, until } from "../sessions/testing/boot.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
const use = (/** @type {string} */ id, /** @type {string} */ name) => ({ type: "assistant", message: { id: "m", role: "assistant", content: [{ type: "tool_use", id, name, input: {} }] } });
const result = (/** @type {string} */ id) => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }] }] } });

test("translate: a screenshot tool's image block is media; another tool's image is not; a non-image type is not", () => {
  translate(use("s1", "mcp__vyre-chrome__chrome_screenshot"));
  translate(use("r1", "Read"));
  assert.deepEqual(translate(result("s1")).media, [{ mime: "image/png", data_b64: PNG, source: "content-block" }]);
  assert.equal(translate(result("r1")).media, undefined, "an image the agent merely read is not a screenshot");
  translate(use("s2", "mcp__vyre-chrome__chrome_screenshot"));
  const odd = { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "s2", content: [{ type: "image", source: { type: "base64", media_type: "image/svg+xml", data: PNG } }] }] } };
  assert.equal(translate(odd).media, undefined, "only png, jpeg, webp and gif");
});

test("a real daemon: the screenshot the fake claude's browser tool returns becomes an artifact of the thread", async t => {
  const w = await boot(t, { driver: "cli" });
  const th = (await w.tool("threads.start", { cwd: w.work, prompt: "shot", surface: "deck" })).data;
  await w.finished(th.id);
  await until(async () => { const r = await w.tool("artifacts.list", {}); const rows = r.data && (r.data.artifacts || r.data); return Array.isArray(rows) && rows.some((/** @type {any} */ a) => a.format === "png" || (a.media && a.media.mime === "image/png")); }, "the screenshot to be kept as an artifact", 20_000);
});
