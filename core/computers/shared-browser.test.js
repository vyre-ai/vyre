// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { FakeDriver } from "./driver/fake.js";
import { Pool, MIGRATIONS } from "./pool.js";
import { open, migrate } from "../store/index.js";
import { tempHome } from "../../test/helpers.js";
import { SharedBrowser, browseMode, SHARED_COMPUTER_ID } from "./shared-browser.js";

const AGENTS = [{ name: "kit", kind: "agent", computer: true, uid: "agt_01234567-89ab-4cde-b012-3456789abcde" }];

function setup(t, { browse = "browser" } = {}) {
  const root = tempHome(t);
  const db = open(path.join(root, "t.db"));
  t.after(() => db.close());
  migrate(db, "computers", MIGRATIONS);
  const driver = new FakeDriver();
  const calls = [];
  const pool = new Pool({
    db, driver,
    call: async (tool, input) => {
      calls.push({ tool, input });
      if (tool === "agents.list") return { data: AGENTS };
      return { error: { message: "no such tool" } };
    },
    emit: () => {},
    config: { driver: "fake", browse, sweepMs: 0 },
    memberTokenKey: () => Promise.resolve("test-member-key"),
  });
  const shared = new SharedBrowser({ pool, call: pool.call, cfg: () => ({ driver: "fake", browse }) });
  return { pool, shared, calls, driver };
}

test("browseMode: fake driver stays desktop unless browse is browser", () => {
  assert.equal(browseMode({ driver: "fake" }), "desktop");
  assert.equal(browseMode({ driver: "fake", browse: "browser" }), "browser");
  assert.equal(browseMode({ browse: "desktop" }), "desktop");
  assert.equal(browseMode({ docker: "http://proxy" }), "browser");
});

test("shared browser: memberCdpToken derives from uid membership", async t => {
  const { pool } = setup(t);
  const computerId = SHARED_COMPUTER_ID;
  const at = pool.now();
  pool.db.prepare(`INSERT INTO computers_computers (agent, container, state, vnc_password, helper_token, paused, created, updated, kind)
    VALUES (?, NULL, 'running', 'vnc', 'helper', 0, ?, ?, 'browser')`).run(computerId, at, at);
  pool.db.prepare(`INSERT INTO computers_members (computer_id, agent_id, agent_name, generation, added_at) VALUES (?, ?, ?, 0, ?)`)
    .run(computerId, AGENTS[0].uid, "kit", at);
  pool.hosts.set(computerId, { host: "fake-shared", ports: { vnc: 5900, helper: 7000 } });
  const token = await pool.memberCdpToken(computerId, AGENTS[0].uid);
  assert.ok(token.length > 20);
});

test("shared browser: view reports browser mode without a screen slot", (t) => {
  const { shared } = setup(t);
  shared.holds.set("kit", { viewers: 1, touched: 0, thread: "th-1", since: 0 });
  const view = shared.view("kit");
  assert.equal(view.screen, null);
  assert.equal(view.mode, "browser");
  assert.equal(view.thread, "th-1");
  assert.equal(view.viewers, 1);
});
