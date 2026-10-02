// A session's own Vyre MCP server (the one --mcp-config names) starts and offers tools, with VYRE_SOCKET its only way to vyred.
import { test } from "node:test";
import assert from "node:assert/strict";
import { boot } from "./testing/boot.js";

test("a session's Vyre MCP server offers tools through the session's own socket", async t => {
  const w = await boot(t, { driver: "cli", sessions: { max_live: 0 } });
  const th = (await w.tool("threads.start", { cwd: w.work, prompt: "mcp-tools", surface: "deck" })).data;
  await w.finished(th.id);
  const text = (await w.events(th.id)).filter(e => e.type === "thread.text" && e.payload.done).map(e => e.payload.text).join(" ");
  assert.match(text, /^mcp vyre: [1-9][0-9]* tools$/, text);
});
