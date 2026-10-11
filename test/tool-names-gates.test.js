// @ts-check
// A proposed name is an alias, and an alias must never reach a tool through a gate that names only the old or only the new spelling. For EVERY person-only and human-only tool that has a proposed name, the
// alias is refused where the tool's own name is: on a session's own socket (403), by the floor when a model's shell names it, and by the session CLI (`vyre call`) before anything leaves.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { PERSON_ONLY, HUMAN_ONLY } from "../core/presence/index.js";
import { openThreadSocket } from "../core/daemon/threadsock.js";
import { rules } from "../core/harness/rules.js";
import { run } from "../core/cli/session.js";
import { proposedNameOf, canonical } from "../lib/tool-names.js";
import { tempHome } from "./helpers.js";

const never = [...new Set([...PERSON_ONLY, ...HUMAN_ONLY])].filter((n) => proposedNameOf(n));

test("the table gives the person-only and human-only tools proposed names, so this guard has something to check", () => {
  assert.ok(never.length >= 20, `${never.length} person-only or human-only tools have a proposed name`);
  for (const n of never) assert.equal(canonical(proposedNameOf(n) || ""), n);
});

test("on a session's own socket every proposed name of a person-only or human-only tool is refused with 403, as the tool's own name is", async (t) => {
  const dir = fs.realpathSync(tempHome(t));
  let reached = 0;
  const s = await openThreadSocket({ handler: () => async () => { reached++; }, thread: "t1", pids: async () => ({ pids: [] }), dir });
  t.after(() => s.close());
  const post = (name) => new Promise((resolve, reject) => { const r = http.request({ socketPath: s.path, path: "/v1/tools/" + encodeURIComponent(name), method: "POST", agent: false }, (res) => { let b = ""; res.on("data", (c) => { b += c; }); res.on("end", () => resolve(res.statusCode + " " + b)); }); r.on("error", reject); r.end("{}"); });
  for (const n of never) {
    const alias = /** @type {string} */ (proposedNameOf(n));
    assert.match(await post(n), /^403 .*the person's own/, `${n} itself`);
    assert.match(await post(alias), /^403 .*the person's own/, `${alias} (the alias of ${n}) was not refused as the person's own`);
  }
  assert.equal(reached, 0, "no refused call reached a route");
});

test("the floor refuses a model's shell that names a proposed name of a person-only tool", () => {
  const home = "/tmp/never-home";
  for (const n of never) {
    const alias = /** @type {string} */ (proposedNameOf(n));
    const v = rules({ tool: "Bash", input: { command: `vyre call ${alias} '{}'` }, cwd: "/tmp", home });
    assert.equal(v.decision, "deny", `${alias} (the alias of ${n}) was not refused by the floor`);
  }
});

test("`vyre call` in a session refuses a proposed name of a person-only tool before anything leaves", async () => {
  for (const n of never) {
    const alias = /** @type {string} */ (proposedNameOf(n));
    const seen = [];
    const code = await run(["call", alias, "{}"], { env: { VYRE_SOCKET: "/run/vyre-threads/x.sock" }, request: /** @type {any} */ (async (/** @type {string} */ m, /** @type {string} */ p) => { seen.push(m + " " + p); return { data: [] }; }), out() {}, err() {} });
    assert.equal(code, 1, `${alias} (the alias of ${n}) was not refused`);
    assert.ok(!seen.some((x) => x.startsWith("POST")), `${alias} left the shell`);
  }
});
