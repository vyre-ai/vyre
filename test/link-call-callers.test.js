// @ts-check
// HD-3 (reviewer-2): link.call forwards a tool to the box as the owner's device, so a model or an agent must never reach it.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { tempHome, present } from "./helpers.js";

test("HD-3: link.call is refused for every model and agent caller before anything is forwarded, and not for the person's own surfaces", { timeout: 60_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "local", transcripts: [] }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  for (const caller of ["mcp", "mcp:thread:t1", "mcp:agent:kit", "harness", "tailnet-guest:sam@harlow.example", "anonymous"]) {
    const r = await d.registry.call("link.call", { tool: "artifacts.share", input: {} }, caller);
    assert.ok(r.error && r.error.code !== "no_link" && r.error.code !== "unpaired", `${caller}: refused for what it is, got ${r.error ? r.error.code : "OK"}`);
  }
  // the person's own surface gets as far as the pairing check (this Mac has no box)
  assert.equal((await d.registry.call("link.call", { tool: "artifacts.share", input: {} }, "cli")).error.code, "no_link");
  // a bare "mobile" is a label any caller can send, not a person (the one list, lib/person-surfaces.js): refused; the phone arrives as its paired device, which link.call does not take either
  const mobile = await d.registry.call("link.call", { tool: "artifacts.share", input: {} }, "mobile");
  assert.ok(mobile.error && mobile.error.code !== "no_link" && mobile.error.code !== "unpaired", `mobile: refused for what it is, got ${mobile.error ? mobile.error.code : "OK"}`);
  // link.call forwards as this Mac's session, so a paired device needs the person's own session first (reach person), and the bare class words are no caller at all
  const dev = await d.registry.call("link.call", { tool: "artifacts.share", input: {} }, "device:abcdefghijklmnop");
  assert.equal(dev.error && dev.error.code, "person_session_required", `a device without a person session is refused: ${JSON.stringify(dev).slice(0, 200)}`);
  const tail = await d.registry.call("link.call", { tool: "artifacts.share", input: {} }, "tailnet");
  assert.ok(tail.error && tail.error.code !== "no_link" && tail.error.code !== "unpaired", `tailnet: refused for what it is, got ${tail.error ? tail.error.code : "OK"}`);
});
