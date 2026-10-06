// @ts-check
// The typed code ships in release (user ruling, 5 Oct 2026): a server config with NO env and NO wink config offers the typed code beside the QR, the code lives ten minutes, three wrong tries close it and the
// fourth is refused, and the kill switch (VYRE_WINK_TYPED_CODE=0 or wink.typedCode: false) turns it off. A real daemon on a real relay; the numbers come from core/wink/code.js alone.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { HUMAN_ONLY } from "../core/presence/index.js";
import { createRelay } from "../relay/node/server.js";
import { typeWinkCode } from "../relay/client/join.js";
import { CODE_TTL_MS, MAX_ATTEMPTS } from "../core/wink/code.js";
import { tempHome } from "./helpers.js";
import { macCore } from "./fake-core-keys.js";

const lenient = {
  required: (tool, def, input) => HUMAN_ONLY.has(tool) || Boolean(def && def.presence && (typeof def.presence.when !== "function" || input === undefined || def.presence.when(input))),
  verify: async ({ proof }) => (proof ? { ok: true, method: "passkey", keyId: proof.key || "k1" } : { ok: false, message: "needs a person", methods: ["passkey"] }),
  challenge: async () => ({ error: { code: "bad_input", message: "no challenges here" } }),
  summary: async () => "", covered: () => false, coverage: () => ({ covered: false, since: null, expires: null }), enrolled: [], enroll(k) { return { id: "kh", kind: k.kind, name: k.name }; },
};
const PROOF = { proof: { method: "passkey", id: "x" } };
const SCREEN = "device:abcdefghijklmnop";
const A = { ...PROOF, peer: { stableId: "nodeA", node: "a" }, person: { id: "ps1" } };

/** A release-like server: no wink config, and the env the test runner may carry is cleared. */
async function server(t, wink) {
  const saved = process.env.VYRE_WINK_TYPED_CODE; delete process.env.VYRE_WINK_TYPED_CODE;
  t.after(() => { if (saved !== undefined) process.env.VYRE_WINK_TYPED_CODE = saved; else delete process.env.VYRE_WINK_TYPED_CODE; });
  const relay = createRelay(); const url = await relay.listen(); t.after(() => relay.close());
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", name: "alex", transcripts: [], network: { name: "alex" }, relay: { enabled: true, url }, ...(wink ? { wink } : {}), modules: { disable: ["names", "onboard"] } }));
  const d = await start({ presence: lenient, root, log: () => {}, coreKeys: macCore() });
  t.after(() => d.stop());
  return { url, call: (tool, input = {}, caller = "cli", meta = A) => d.registry.call(tool, input, caller, meta) };
}

test("the numbers are stated once: ten minutes and three tries in code.js", () => {
  assert.equal(CODE_TTL_MS, 10 * 60_000);
  assert.equal(MAX_ATTEMPTS, 3);
});

test("a release server with no env set offers the typed code beside the QR, good for ten minutes, and the fourth try is refused", async t => {
  const s = await server(t);
  const t0 = Date.now();
  const made = (await s.call("wink.server.code", { qr: true })).data;
  assert.match(made.code, /^WINK-[0-9A-Z]{4}-[0-9A-Z]{4}$/, "the typed code is shown by default");
  assert.ok(made.qr && /^vyre:\/\/wink\//.test(made.qr), "beside the long code");
  assert.ok(made.code_expires - t0 > CODE_TTL_MS - 15_000 && made.code_expires - t0 <= CODE_TTL_MS + 1000, `the typed code expires in about ten minutes (${Math.round((made.code_expires - t0) / 1000)} s)`);
  // three wrong tries (a wrong last character each time), each answered "no"; the fourth, even with the RIGHT code, is refused: the code is closed
  const wrong = made.code.slice(0, -1) + (made.code.endsWith("A") ? "B" : "A");
  for (let i = 1; i <= MAX_ATTEMPTS; i++) { const r = await typeWinkCode({ relay: s.url, input: wrong }); assert.equal(r.ok, false, `try ${i} is refused`); }
  const fourth = await typeWinkCode({ relay: s.url, input: made.code });
  assert.equal(fourth.ok, false, "the fourth try is refused, even with the right code");
});

test("the kill switch turns the typed code off: VYRE_WINK_TYPED_CODE=0, and wink.typedCode: false in the config", async t => {
  const a = await server(t);
  process.env.VYRE_WINK_TYPED_CODE = "0";
  const off = await a.call("wink.server.code", { typed: true });
  assert.equal(off.error?.code, "typed_code_off");
  assert.equal((await a.call("wink.code.open", { flow: "W3" })).error?.code, "typed_code_off");
  const plain = (await a.call("wink.server.code", { qr: true })).data;
  assert.ok(plain.qr && !plain.code, "the QR and long code still work, with no typed code");
  delete process.env.VYRE_WINK_TYPED_CODE;
  const b = await server(t, { typedCode: false });
  assert.equal((await b.call("wink.server.code", { typed: true })).error?.code, "typed_code_off");
});
