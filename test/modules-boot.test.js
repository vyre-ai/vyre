// @ts-check
// Every first-party module loads and starts the way the daemon starts it. A module that throws while its files load (a bad import, a cycle: "Cannot access X before
// initialization") or in start() is "failed" in the registry and its tools are gone, and nothing else notices: the daemon boots without it. This boots them all in a
// temp home, once per role the daemon runs in, and fails on any module in state failed. A module that cannot run in a bare home says so in EXPECTED with the reason.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Registry, discover } from "../core/modules/index.js";
import { open } from "../core/store/index.js";
import { Events } from "../core/events/index.js";
import * as config from "../core/config/index.js";
import { tempHome } from "./helpers.js";

const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "core");
/** Modules that need something a bare test home does not have. Each says what. Keep this empty or shrinking. */
const EXPECTED = /** @type {Record<string, string>} */ ({
  onboard: "needs the daemon's router to hand out; a bare registry has none",
  "space-sessions": "BROKEN on work/v0.3: its entry file does not export default { start(ctx) } (owner: sessions). Remove this line when it is fixed",
});

for (const role of /** @type {const} */ (["box", "local"])) {
  test(`every first-party module loads and starts as the ${role} (the daemon's way)`, async t => {
    const root = tempHome(t);
    const p = config.ensure(root);
    const found = discover([CORE]).filter(f => f.manifest && (f.manifest.roles || []).includes(role));
    const db = open(p.db);
    const events = new Events(db);
    const logs = /** @type {string[]} */ ([]);
    const reg = new Registry({ db, events, config: { role, name: "testbox", names: { directory: "http://127.0.0.1:1" } }, paths: p, log: (/** @type {any} */ m) => logs.push(String(m)), presence: /** @type {any} */ ({ required: () => false, verify: async () => ({ ok: false }) }) });
    t.after(async () => { try { await reg.stop(); } catch { /* stopping a failed module */ } db.close(); });
    await reg.start(found, { role });
    const failed = [...reg.modules.entries()].filter(([name, m]) => m.state === "failed" && !EXPECTED[name]).map(([name, m]) => `${name}: ${m.error}`);
    assert.deepEqual(failed, [], "a module failed to load or start");
    assert.ok(reg.modules.size >= found.length - Object.keys(EXPECTED).length, "every module was tried");
  });
}
