// @ts-check
// The Computer tab's words for each state an agent's computer cannot run in: no driver, no image, the computer service refusing or not answering.
// What a driver or the proxy said goes to the log; a person reads a sentence that says what to do.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainComputerError, plainError, NO_DRIVER_WORDS, IMAGE_MISSING_WORDS, PROXY_REFUSED_WORDS, PROXY_DOWN_WORDS, NOT_STARTED_WORDS, NO_EXEC_WORDS } from "./plain.js";
import { NO_DRIVER } from "./pool.js";

test("each state has its own plain sentence and an error code the catalogue knows", () => {
  const cases = [
    [NO_DRIVER, "unavailable", NO_DRIVER_WORDS],
    ["no computer driver is configured on this machine: set computers.docker in config.json to the restricted Docker proxy", "unavailable", NO_DRIVER_WORDS],
    ["docker POST /containers/create?name=run.vyre.computers-computer-browser-shared: No such image: ghcr.io/vyre-ai/vyre-computer@sha256:" + "5".repeat(64), "computer_unavailable", IMAGE_MISSING_WORDS],
    ["docker POST /containers/create?name=x: vyre docker proxy: create: the image is not the box's", "computer_unavailable", PROXY_REFUSED_WORDS],
    ["docker GET /containers/json: vyre docker proxy: no bearer yet: vyred has not set agents' computers up on this server", "computer_unavailable", PROXY_DOWN_WORDS],
    ["docker GET /containers/json: vyre docker proxy: missing or wrong bearer", "computer_unavailable", PROXY_DOWN_WORDS],
    ["docker GET /containers/json: connect ECONNREFUSED 172.18.0.3:2375", "computer_unavailable", PROXY_DOWN_WORDS],
    ["docker GET /containers/json: getaddrinfo ENOTFOUND docker-api", "computer_unavailable", PROXY_DOWN_WORDS],
    ["the agent computer is not set up on this machine: its container is not running, or this machine's driver cannot run commands in it", "unavailable", NO_EXEC_WORDS],
    ["browser-shared's computer stopped as soon as it started (exit code 1)", "computer_unavailable", NOT_STARTED_WORDS],
  ];
  for (const [msg, code, words] of cases) assert.deepEqual(plainComputerError(new Error(msg)), { code, message: words }, msg);
  for (const w of [NO_DRIVER_WORDS, IMAGE_MISSING_WORDS, PROXY_REFUSED_WORDS, PROXY_DOWN_WORDS, NOT_STARTED_WORDS, NO_EXEC_WORDS]) {
    assert.doesNotMatch(w, /vyred|docker|driver|container|computers\.[a-z]|config\.json|bearer/i, `no internal word: ${w}`);
    assert.match(w, /\.$/);
  }
});

test("the person sees the owner's exact sentence when this server has no driver", () => {
  assert.equal(NO_DRIVER, "Agent computers aren't set up on this server yet. Update the server to turn them on.");
});

test("a message that already speaks to the person passes through unchanged, and plainError keeps the driver's words for the log", () => {
  assert.equal(plainComputerError(new Error("you cannot use that agent: ask its owner to share it with you")), null);
  const own = new Error("someone is watching or has taken over this computer");
  assert.equal(plainError(own), own);
  const e = /** @type {any} */ (plainError(new Error("docker POST /containers/create: No such image: vyre/computer:0.1")));
  assert.equal(e.message, IMAGE_MISSING_WORDS);
  assert.equal(e.code, "computer_unavailable");
  assert.match(e.detail, /No such image/);
});
