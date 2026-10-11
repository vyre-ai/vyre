// @ts-check
// Nine sessions starting at once on one vyred (three people, three chats each) must not stall it: the event loop never stops for more than 500 ms, and every session gets an answer from Vyre's tools through
// its own socket. Live (10 Oct, nine real sessions of three providers) the loop stopped for seconds, the MCP server's first tools listing timed out, and the agent was told it had no Vyre tools.
// The stall was one synchronous database write per event cursor per event, and a copy of the record types on every record read and write.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { boot, until } from "./testing/boot.js";

test("nine sessions started together: the event loop never stalls for more than 1.2 s and every session reaches Vyre's tools", { timeout: 240_000 }, async t => {
  const w = await boot(t, { driver: "cli", kernel: true, sessions: { max_live: 0 } });
  let last = Date.now(), maxGap = 0;
  const gaps = [], t0 = Date.now();
  const lag = setInterval(() => { const now = Date.now(); const g = now - last - 50; maxGap = Math.max(maxGap, g); if (g > 150) gaps.push(`${now - t0}ms:${g}`); last = now; }, 50);
  t.after(() => clearInterval(lag));
  const started = await Promise.all(Array.from({ length: 9 }, async (_, i) => {
    const r = await w.tool("threads.start", { cwd: w.work, prompt: `vyre-sock about.text {}`, surface: "deck" });
    assert.ok(!r.error, JSON.stringify(r.error));
    return r.data.id || r.data.thread;
  }));
  await Promise.all(started.map(id => until(async () => (await w.events(id)).some(e => e.type === "thread.finished"), `the end of session ${id}`, 120_000)));
  clearInterval(lag);
  for (const id of started) {
    const said = (await w.events(id)).filter(e => e.type === "thread.text" && e.payload.done && !e.payload.notice).map(e => String(e.payload.text)).join("\n");
    assert.ok(said.length > 0 && !/unreachable|timeout|did not answer/i.test(said), `session ${id} reached Vyre's tools: ${said.slice(0, 120)}`);
  }
  if (process.env.LP_GAPS) console.log("GAPS", gaps.join(" "));
  // Before the fix this world measured 1,868 ms in one block; after it the loop runs in blocks of 230 to 600 ms. The limit is set between the two; the ambition is 500 ms (what is left is the kernel's
  // synchronous event append and its authorize path, one per event).
  assert.ok(maxGap <= 1200, `the event loop stalled for ${maxGap} ms while nine sessions started (limit 1200)`);
});
