// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserProfiles } from "./browser-profiles.js";
import { agentProfilePath } from "../../lib/browser-profile-store.js";

test("BrowserProfiles: persistAgent seals export on disk", async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-bprof-"));
  const computerId = "browser-test";
  const agentId = "agt_kit";
  /** @type {any} */
  const pool = {
    members: () => [{ agent_id: agentId }],
    endpoint: () => ({ helper: { url: "http://127.0.0.1:9/", token: "tok" } }),
    async _helperFetch(url, init) {
      if (String(url).endsWith("/agents/profile/export")) {
        return { ok: true, json: async () => ({ state: { v: 1, cookies: [{ name: "a", value: "b", domain: "x", path: "/" }] } }) };
      }
      if (String(url).endsWith("/agents/profile/import")) {
        return { ok: true, json: async () => ({ imported: true }) };
      }
      return { ok: false, json: async () => ({}) };
    },
  };
  const bp = new BrowserProfiles({ pool, dataRoot, agentKey: async () => "0".repeat(64), log: () => {} });
  await bp.persistAgent(computerId, agentId);
  assert.ok(fs.existsSync(agentProfilePath(dataRoot, computerId, agentId)));
  fs.rmSync(dataRoot, { recursive: true, force: true });
});
