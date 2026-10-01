// @ts-check
// Who may change a box's name, owner or sign-in (reviewer-2): the person's own surfaces and devices, and only the named
// modules that run those steps for them. A model session, an agent, a hook, a guest and any other module are refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { start } from "../core/daemon/index.js";
import { tempHome } from "./helpers.js";

async function box(t) {
  const root = tempHome(t);
  const bin = path.join(fs.mkdtempSync(path.join(root, "bin-")), "tailscale");
  fs.writeFileSync(bin, `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify({ BackendState: "NeedsLogin", TUN: true, OperatorUser: os.userInfo().username })}\nEOF\n`, { mode: 0o755 });
  const was = { bin: process.env.VYRE_TAILSCALE_BIN, dev: process.env.VYRE_NAMES_DEV_CLOUDFLARE, tok: process.env.CLOUDFLARE_VYRE_TOKEN };
  process.env.VYRE_TAILSCALE_BIN = bin; process.env.VYRE_NAMES_DEV_CLOUDFLARE = "1"; delete process.env.CLOUDFLARE_VYRE_TOKEN;
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], network: { onboardPort: 0 } }));
  const d = await start({ root, log: () => {} });
  t.after(async () => {
    await d.stop();
    for (const [k, v] of [["VYRE_TAILSCALE_BIN", was.bin], ["VYRE_NAMES_DEV_CLOUDFLARE", was.dev], ["CLOUDFLARE_VYRE_TOKEN", was.tok]]) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });
  return d;
}

// recover is also a presence tool: a caller that cannot prove a person is here (an agent claim on a surface label) stops there, before the reach check.
const refused = r => r.error && ["denied", "no_such_tool", "presence_required"].includes(r.error.code);

test("names: claim, fallback, connect, release, owner and recover refuse a model session, an agent, a hook, a guest and any other module", async t => {
  const d = await box(t);
  const callers = ["mcp", "mcp:thread:t1", "mcp:agent:kit", "harness", "cli:agent:kit", "module:sneaky", "module:vault", "hook", "anonymous", "tailnet-guest:sam@example.com", "tailnet:agent:kit"];
  const calls = [["names.claim", { name: "alex" }], ["names.fallback", {}], ["names.connect", {}], ["names.release", {}], ["names.owner", { login: "mallory@example.com" }],
    ["names.recover", { name: "alex", code: "abcd-efgh-ijkl-mnop-qrst-uv" }], ["names.domain.serve", { domain: "example.com" }]];
  for (const c of callers) for (const [tool, input] of calls) {
    const r = await d.registry.call(tool, input, c);
    assert.ok(refused(r), `${tool} from ${c}: ${JSON.stringify(r).slice(0, 200)}`);
  }
  assert.equal(d.registry.status().find(m => m.name === "names")?.state, "running");
  assert.equal(d.registry.deps.config.name, undefined, "nothing was claimed");
});

test("names: the person's surfaces and the named modules still reach what they need", async t => {
  const d = await box(t);
  // allowed callers are not refused by the reach check (the call itself may still fail on its own terms)
  for (const [tool, input, who] of [["names.claim", { name: "a" }, "cli"], ["names.claim", { name: "a" }, "deck"], ["names.claim", { name: "a" }, "module:onboard"], ["names.claim", { name: "a" }, "module:launch"],
    ["names.fallback", {}, "module:onboard"], ["names.connect", {}, "module:onboard"], ["names.release", {}, "cli"], ["names.owner", { login: "alex@example.com" }, "module:network"],
    ["names.owner", { login: "alex@example.com" }, "cli"], ["names.claim", { name: "a" }, "device:abcdefghijklmnop"]]) {
    const r = await d.registry.call(tool, input, who);
    assert.notEqual(r.error && r.error.code, "denied", `${tool} from ${who}: ${JSON.stringify(r).slice(0, 200)}`);
    assert.notEqual(r.error && r.error.code, "no_such_tool", `${tool} from ${who}`);
  }
  // but a module that is not onboard, launch or network is not one of them, and onboard may not release or reassign the owner
  assert.ok(refused(await d.registry.call("names.release", {}, "module:onboard")));
  assert.ok(refused(await d.registry.call("names.owner", { login: "x@example.com" }, "module:onboard")));
});
