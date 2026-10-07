// @ts-check
// vyre wink reset: needs a terminal, shows the one-time code on that terminal only, sends the daemon a hash and never the code on begin.
import "../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { run } from "./wink.js";
import { setJson } from "../kit.js";
import { codeHash, normalise } from "../../../lib/wink-reset.js";

/** @param {{ isTTY?: boolean, replies?: any }} [o] */
function deps(o = {}) {
  const calls = /** @type {any[]} */ ([]), wrote = /** @type {string[]} */ ([]);
  return { calls, wrote, d: {
    isTTY: o.isTTY ?? true,
    ensureUp: async () => ({ ok: true }),
    call: async (/** @type {string} */ tool, /** @type {any} */ input) => { calls.push([tool, input]); const r = o.replies && o.replies[tool]; return r ? r(input) : { data: tool.endsWith("begin") ? { begun: true, until: 1 } : { reset: true, had: true } }; },
    write: (/** @type {string} */ s) => { wrote.push(s); },
    ask: async () => "ABCD-EFGH",
    newCode: () => "K7QM-4P2X",
  } };
}
/** Captures what the command prints on stdout and stderr. @param {() => Promise<any>} f */
async function capture(f) {
  const out = /** @type {string[]} */ ([]);
  const o = process.stdout.write.bind(process.stdout), e = process.stderr.write.bind(process.stderr);
  process.stdout.write = /** @type {any} */ ((/** @type {any} */ x) => { out.push(String(x)); return true; });
  process.stderr.write = /** @type {any} */ ((/** @type {any} */ x) => { out.push(String(x)); return true; });
  try { return { code: await f(), out: out.join("") }; } finally { process.stdout.write = o; process.stderr.write = e; setJson(false); }
}

test("--begin: the code goes to the terminal, the daemon gets a salt and a hash that matches it, never the code", async () => {
  const { d, calls, wrote } = deps();
  const r = await capture(() => run(["reset", "--begin"], /** @type {any} */ (d)));
  assert.equal(r.code, 0);
  assert.match(wrote.join(""), /Reset code: K7QM-4P2X/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "wink.server.reset.begin");
  assert.deepEqual(Object.keys(calls[0][1]).sort(), ["hash", "salt"]);
  assert.equal(calls[0][1].hash, codeHash("K7QM-4P2X", calls[0][1].salt));
  assert.ok(!JSON.stringify(calls).includes(normalise("K7QM-4P2X")) && !JSON.stringify(calls).includes("K7QM"));
});

test("--begin --json: the code is on the terminal and not in the JSON", async () => {
  setJson(true);
  const { d, wrote } = deps();
  const r = await capture(() => run(["reset", "--begin", "--json"], /** @type {any} */ (d)));
  assert.equal(r.code, 0);
  assert.ok(!r.out.includes("K7QM"), "stdout and stderr hold no code");
  assert.match(wrote.join(""), /K7QM-4P2X/);
});

test("--confirm sends the typed code, from the argument or a prompt, and says what happened", async () => {
  const a = deps(), b = deps();
  const ra = await capture(() => run(["reset", "--confirm", "k7qm-4p2x"], /** @type {any} */ (a.d)));
  assert.equal(ra.code, 0);
  assert.deepEqual(a.calls, [["wink.server.reset.confirm", { code: "k7qm-4p2x" }]]);
  assert.match(ra.out, /let go of its owner/);
  const rb = await capture(() => run(["reset", "--confirm"], /** @type {any} */ (b.d)));
  assert.equal(rb.code, 0);
  assert.deepEqual(b.calls, [["wink.server.reset.confirm", { code: "ABCD-EFGH" }]]);
});

test("without a terminal both steps are refused before the daemon is asked (the model's shell has none)", async () => {
  for (const args of [["reset", "--begin"], ["reset", "--confirm", "K7QM-4P2X"]]) {
    const { d, calls, wrote } = deps({ isTTY: false });
    const r = await capture(() => run(args, /** @type {any} */ (d)));
    assert.equal(r.code, 3, args.join(" "));
    assert.deepEqual(calls, []);
    assert.deepEqual(wrote, []);
  }
});

test("a refusal from the daemon exits 1 and a lock says when", async () => {
  const { d } = deps({ replies: { "wink.server.reset.confirm": () => ({ error: { code: "reset_locked", message: "Resetting this server is locked until 1970-01-01 01:00 UTC, after too many wrong codes." } }) } });
  const r = await capture(() => run(["reset", "--confirm", "AAAA-AAAA"], /** @type {any} */ (d)));
  assert.equal(r.code, 1);
  assert.match(r.out, /locked until/);
});

test("usage: one of --begin or --confirm, nothing else", async () => {
  for (const args of [["reset"], ["reset", "--begin", "--confirm"], ["reset", "ABCD-EFGH"], ["other", "--begin"], ["reset", "--begin", "extra"]]) {
    const { d, calls } = deps();
    const r = await capture(() => run(args, /** @type {any} */ (d)));
    assert.equal(r.code, 2, args.join(" "));
    assert.deepEqual(calls, []);
  }
});

const ASKING = { asking: true, name: "Harlow's Mac", choices: ["red oak sky", "net pie ash", "fox elm dew"], until: 1, line: "x" };
test("confirm: shows the choices and sends the pick; nothing asking says so; no terminal is refused", async () => {
  const a = deps({ replies: { "wink.server.pairing": () => ({ data: ASKING }), "wink.server.pair.answer": () => ({ data: { answered: true, yes: true, name: "Harlow's Mac" } }) } });
  a.d.ask = async () => "2";
  const r = await capture(() => run(["confirm"], /** @type {any} */ (a.d)));
  assert.equal(r.code, 0);
  assert.deepEqual(a.calls, [["wink.server.pairing", {}], ["wink.server.pair.answer", { yes: true, pick: 2 }]]);
  assert.match(r.out, /1\) red oak sky/);
  const n = deps({ replies: { "wink.server.pairing": () => ({ data: { asking: false } }) } });
  const rn = await capture(() => run(["confirm"], /** @type {any} */ (n.d)));
  assert.equal(rn.code, 0);
  assert.deepEqual(n.calls, [["wink.server.pairing", {}]]);
  const t = deps({ isTTY: false });
  const rt = await capture(() => run(["confirm"], /** @type {any} */ (t.d)));
  assert.notEqual(rt.code, 0);
  assert.deepEqual(t.calls, []);
  const x = deps({ replies: { "wink.server.pairing": () => ({ data: ASKING }), "wink.server.pair.answer": () => ({ data: { answered: true, yes: false, name: "m" } }) } });
  const rx = await capture(() => run(["confirm", "--no"], /** @type {any} */ (x.d)));
  assert.equal(rx.code, 0);
  assert.deepEqual(x.calls[1], ["wink.server.pair.answer", { yes: false }]);
});
