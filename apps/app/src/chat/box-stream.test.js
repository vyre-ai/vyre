// The group writes in box-stream go to the server's stream.* tools with their inputs, through the box layer's send.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("./box-stream.ts", import.meta.url), "utf8");

test("box-stream has sendGroup, keep, react, pin and markRead, each a stream.* tool through write()", () => {
  for (const [fn, tool] of [["sendGroup", "stream.send"], ["keep", "stream.keep"], ["react", "stream.react"], ["pin", "stream.pin"], ["markRead", "stream.mark-read"]]) {
    assert.match(src, new RegExp(`${fn}:[^\\n]*|${fn}: async`), fn);
    assert.ok(src.includes(`"${tool}"`), tool);
  }
  assert.ok(!/fetch\(|XMLHttpRequest/.test(src), "writes never bypass the outbox");
  assert.match(src, /async function write[\s\S]*send</, "write goes through the box layer's send (outbox, Idempotency-Key)");
});
