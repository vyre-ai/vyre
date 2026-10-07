import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { Registry, discover } from "../../core/modules/index.js";
import { open } from "../../core/store/index.js";
import { Events } from "../bus.js";
import { tempHome, writeModule } from "../../test/helpers.js";
import { mechanism } from "./sandbox.js";
import { createSupervisor } from "./supervisor.js";
import { createModuleHost } from "./host.js";
import { createEgress } from "./egress.js";
import { createEventLog } from "../core/events.js";
import { createChainBuilder } from "../core/chain.js";

const SPACE = "spc_aaaaaaaaaaaa";
const chains = createChainBuilder({ space: SPACE, owner: "per_owner", owner_uid: 501, key: Buffer.alloc(32, 9) });
const linux = process.platform === "linux" && mechanism() === "bwrap";
const manifest = { does: { tools: [{ name: "notes.add", reach: "anyone" }] }, needs: { egress: ["api.example.com"] } };
const src = `export const handlers = { "notes.add": async ({ input }) => ({ saved: input.text, env: Object.keys(process.env).filter(k => !["PATH", "VYRE_MODULE_ENTRY", "PWD"].includes(k)) }) };`;

async function boot(t, deps) {
  const home = tempHome(t);
  const root = path.join(home, "mods");
  writeModule(root, "notes", manifest, src);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  const reg = new Registry({ db, events: new Events(db), config: { role: "local" }, log: () => {}, moduleApprovals: () => ["api.example.com"], ...deps });
  await reg.start(discover([root]), { role: "local" });
  return reg;
}

test("registry: with a module host, an added module is refused while the supervisor is unproved, and nothing of it runs in this process", async t => {
  const log = createEventLog({ space: SPACE });
  const host = createModuleHost({ space: SPACE, log, chains, isFirstParty: () => false, supervisor: createSupervisor({ platform: "win32" }) });
  const reg = await boot(t, { moduleHost: host });
  const st = reg.status().find(m => m.name === "notes");
  assert.equal(st.state, "failed");
  assert.match(st.error, /supervisor/);
  assert.equal((await reg.call("notes.add", { text: "x" })).error.code, "no_such_tool");
});

test("registry: with a proved supervisor an added module runs sandboxed and its tool answers through the registry", { skip: !linux, timeout: 60_000 }, async t => {
  const log = createEventLog({ space: SPACE });
  const supervisor = createSupervisor({ egress: createEgress({ space: SPACE, hostsOf: () => [], resolve: async () => [] }) });
  await supervisor.selfTest();
  t.after(() => supervisor.stopAll());
  const host = createModuleHost({ space: SPACE, log, chains, isFirstParty: () => false, supervisor });
  const reg = await boot(t, { moduleHost: host });
  assert.equal(reg.status().find(m => m.name === "notes").state, "running");
  // An undeclared state-changing tool is person-only by the registry default (RG-1), so the call comes from a person's surface, not from the default "unknown" caller.
  const r = await reg.call("notes.add", { text: "hello" }, "cli");
  assert.equal(r.data.saved, "hello");
  assert.deepEqual(r.data.env, [], "no ambient environment in the sandbox");
});

test("registry: without a module host nothing changes (the default stays off until the kernel default-on path)", async t => {
  const reg = await boot(t, {});
  assert.equal(reg.status().find(m => m.name === "notes").state, "failed", "the in-process path needs a default export; this module has only handlers");
});
