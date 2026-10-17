// @ts-check
import "../../scripts/mac-test-guard.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { registerComposerSlashTools } from "./composer-slash.js";
import { personCallOpts } from "../../lib/person-relay.js";

/** @type {any} */ let slash;
const str = { type: "string" };

function boot(/** @type {Record<string, unknown>[]} */ seen) {
  slash = undefined;
  const ctx = {
    call: async (/** @type {string} */ tool, /** @type {any} */ input, /** @type {any} */ opts) => {
      seen.push({ tool, input, opts });
      if (tool === "threads.get") return { data: { thread: { model: "sonnet" } } };
      return { data: { ok: true } };
    },
  };
  registerComposerSlashTools((/** @type {string} */ name, _d, _s, run) => { if (name === "threads.slash") slash = run; }, {
    sb: { commands: () => ({}) },
    ctx,
    guard: () => {},
    queuesFor: () => true,
    personTurn: (/** @type {unknown} */ c) => c === "deck" || c === "cli",
    surfaceOf: () => "deck",
    str,
  });
  assert.ok(slash, "threads.slash registered");
  return ctx;
}

test("threads.slash runs /later and /find as the calling person's surface", async () => {
  const seen = [];
  boot(seen);
  const deckMeta = { caller: "deck", token: "tok-d", kernelFacts: { kind: "device", person: "per_deck" } };
  const cliMeta = { caller: "cli", token: "tok-c" };
  await slash({ thread: "t1", line: "/later at 5pm tea" }, deckMeta);
  await slash({ thread: "t1", line: "/find intake" }, cliMeta);
  assert.deepEqual(seen.map((x) => [x.tool, x.opts]), [["planner.add", personCallOpts("deck", deckMeta)], ["recall.search", personCallOpts("cli", cliMeta)]]);
});

test("threads.slash refuses /later and /find from a model session", async () => {
  boot([]);
  await assert.rejects(() => slash({ thread: "t1", line: "/later x" }, { caller: "mcp:agent:kit" }), (/** @type {any} */ e) => e.code === "denied");
  await assert.rejects(() => slash({ thread: "t1", line: "/find x" }, { caller: "mcp:thread:t1" }), (/** @type {any} */ e) => e.code === "denied");
});
