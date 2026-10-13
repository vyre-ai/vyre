// @ts-check
// Adding or removing accounts, rewriting session history and setting up a local repository are the person's acts (owner's ruling via the lead, 13 Oct 2026): an agent, a model, a guest
// or an MCP caller is refused on each, whatever it sends. The person's own surface is not refused for who it is (it may fail for other reasons with empty input).
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";

const TOOLS = ["connectors.connect", "connectors.connect.finish", "connectors.connect.cancel", "connectors.disconnect", "google.add", "google.connect", "github.session.undo", "github.session.redo", "github.project.local-init", "mcp.add", "mcp.update", "mcp.remove", "mcp.test", "google.test", "vault.relay", "vault.me.store.get", "vault.me.store.put", "vault.me.store.list", "vault.me.store.remove"];

/** the tools first-party modules call: their body refuses, so an agent and an mcp caller get "denied" */
const BODY = new Set(["vault.me.store.get", "vault.me.store.put", "vault.me.store.list", "vault.me.store.remove", "mcp.add", "mcp.update", "mcp.remove", "mcp.test", "google.test", "vault.relay"]);

/** inputs that satisfy each tool's schema, so the refusal is about who asked */
const INPUT = /** @type {Record<string, any>} */ ({ "github.session.undo": { project: "app", session: "s1" }, "github.session.redo": { project: "app", session: "s1" }, "github.project.local-init": { project: "app" }, "mcp.add": { name: "x", transport: "http", url: "https://example.com" }, "mcp.update": { name: "x" }, "mcp.remove": { name: "x" }, "mcp.test": { name: "x" }, "google.test": { name: "x" }, "vault.relay": { item: "i", request: { url: "https://example.com" } }, "vault.me.store.get": { key: "k" }, "vault.me.store.put": { key: "k", value: 1 }, "vault.me.store.list": {}, "vault.me.store.remove": { key: "k" } });

test("an agent, a model, a guest or an MCP caller is refused on the account and session-history tools: person surfaces only", { timeout: 120_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", name: "alex", transcripts: [] }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  for (const name of TOOLS) assert.ok(d.registry.tools.get(name), `${name} is registered`);
  for (const as of ["mcp:agent:kit", "cli:agent:kit", "mcp", "harness", "tailnet-guest"]) {
    for (const name of TOOLS) {
      const r = await d.registry.call(name, INPUT[name] || {}, as);
      assert.ok(r.error, `${as} on ${name} ran: ${JSON.stringify(r).slice(0, 140)}`);
      if (BODY.has(name) && (as === "mcp:agent:kit" || as === "cli:agent:kit" || as === "mcp")) assert.equal(r.error.code, "denied", `${as} on ${name}: ${JSON.stringify(r.error).slice(0, 140)}`);
      assert.notEqual(r.error.code, "bad_input", `${as} on ${name} was judged on its input, not on who asked: ${JSON.stringify(r.error).slice(0, 140)}`);
    }
  }
});
