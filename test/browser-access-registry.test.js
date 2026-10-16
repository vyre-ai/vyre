// @ts-check
// Agent browser entry points stay on one implementation (lib/browser-access.js, core/computers/agent-browser.js).
// AGENT_BROWSER_GATES is the inventory; this test keeps every listed path real and wired to the shared gates.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_BROWSER_GATES } from "../lib/browser-access.js";
import { findInSource } from "./source-files.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** @type {Record<string, RegExp>} */
const GATE_MARKERS = {
  cdpViaEndpoint: /computers\.endpoint|agent-browser|AgentBrowser|browser-access|computer-agent|resolveComputerAgent/,
  cdpViaFill: /agent-fill|computers\.fill/,
  navigateEgress: /guardAgentNavigate|requirePublicUrl|browser-access/,
  glassStream: /browser-glass|\/v1\/streams\/computers\/glass|glassStreamPath|LiveScreen|computers\.watch|glass\.open/,
  helperViaAgentBrowser: /computers\.helper|agent-browser|AgentBrowser|tellComputerd|deps\.helper|this\.helper\(|deps\.tell|this\.tell/,
};

test("AGENT_BROWSER_GATES: every listed path exists and declares the shared gate", () => {
  for (const [kind, files] of Object.entries(AGENT_BROWSER_GATES)) {
    const re = GATE_MARKERS[kind];
    assert.ok(re, `unknown gate kind ${kind}`);
    for (const rel of files) {
      const abs = path.join(ROOT, rel);
      assert.ok(fs.existsSync(abs), `${rel} is listed in ${kind} but missing`);
      const text = fs.readFileSync(abs, "utf8");
      assert.match(text, re, `${rel} must go through the ${kind} gate (${re})`);
    }
  }
});

/** Files allowed to open CDP or build a /cdp URL without going through cdpUrlOf / AgentBrowser.openCdp. */
const CDP_ALLOWED = new Map([
  ["lib/cdp.js", "the CDP client"],
  ["lib/browser-access.js", "cdpUrlOf"],
  ["core/computers/agent-browser.js", "openCdp"],
  ["core/vault/agent-fill.js", "vault fill-only CDP (computers.fill.begin token)"],
  ["modules/hands-chrome/cdp.js", "pool; URL comes from computers.endpoint + cdpUrlOf in index.js"],
  ["core/computers/image/computerd/", "container-side CDP mux"],
  ["local/hands-chrome-mac/", "Mac person-Chrome spike; not the box agent path"],
]);

const CDP_PATTERNS = [/new\s+Cdp\s*\(/, /helper\.url\}\/cdp/, /\.url\}\s*\+\s*["']\/cdp/];

test("agent CDP opens only through the shared gates", () => {
  const found = findInSource(CDP_PATTERNS, CDP_ALLOWED);
  assert.deepEqual(found, [], "open CDP or build helper.url/cdp outside the browser-access gates");
});
