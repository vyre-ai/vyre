// @ts-check
// Tests for the Vault's terminal helpers. The hidden prompt is driven through a fake terminal so
// the test can prove exactly what reached the screen: the question, and nothing typed.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { hiddenPrompt, visiblePrompt, Scrubber, CONCEALED, parseRunArgs, envName, flags } from "./cli-io.js";

function fakeTTY() {
  const input = /** @type {any} */ (new PassThrough());
  input.isTTY = true;
  input.modes = [];
  input.setRawMode = m => { input.modes.push(m); input.isRaw = m; return input; };
  const output = new PassThrough();
  let shown = "";
  output.on("data", c => { shown += c; });
  return { input, output, shown: () => shown };
}

test("hiddenPrompt on a terminal shows the question and nothing typed, and restores raw mode", async () => {
  const t = fakeTTY();
  const p = hiddenPrompt("value: ", { input: t.input, output: t.output });
  t.input.write("s3cr");
  t.input.write("et-value\r");
  assert.equal(await p, "s3cret-value");
  await new Promise(r => setImmediate(r));
  assert.equal(t.shown(), "value: \n");
  assert.ok(!t.shown().includes("s3cr") && !t.shown().includes("*"));
  assert.deepEqual(t.input.modes, [true, false]);
  assert.equal(t.input.isPaused(), true);
});

test("hiddenPrompt handles backspace", async () => {
  const t = fakeTTY();
  const p = hiddenPrompt("value: ", { input: t.input, output: t.output });
  t.input.write("abcx\u007f\u007fd\bD\n");
  assert.equal(await p, "abD");
  assert.deepEqual(t.input.modes, [true, false]);
});

test("hiddenPrompt rejects on Ctrl-C and still restores raw mode", async () => {
  const t = fakeTTY();
  const p = hiddenPrompt("value: ", { input: t.input, output: t.output });
  t.input.write("half\u0003");
  await assert.rejects(p, /cancelled/);
  assert.deepEqual(t.input.modes, [true, false]);
  assert.equal(t.input.isPaused(), true);
  await new Promise(r => setImmediate(r));
  assert.ok(!t.shown().includes("half"));
});

test("hiddenPrompt without a terminal reads everything and strips one trailing newline", async () => {
  const input = new PassThrough(), output = new PassThrough();
  let shown = "";
  output.on("data", c => { shown += c; });
  const p = hiddenPrompt("value: ", { input, output });
  input.end("line one\nline two\n\n");
  assert.equal(await p, "line one\nline two\n");
  assert.equal(shown, "");
});

test("visiblePrompt reads one line", async () => {
  const input = new PassThrough(), output = new PassThrough();
  const p = visiblePrompt("username: ", { input, output });
  input.write("someone@example.com\n");
  assert.equal(await p, "someone@example.com");
});

async function scrub(values, chunks) {
  const s = new Scrubber(values);
  const got = [];
  s.on("data", c => got.push(c));
  const done = new Promise(r => s.on("end", r));
  for (const c of chunks) s.write(c);
  s.end();
  await done;
  return Buffer.concat(got).toString("utf8");
}

test("Scrubber conceals a value split across three chunks", async () => {
  const out = await scrub(["sk-live-ABCDEF123"], ["token=sk-li", "ve-ABC", "DEF123 done"]);
  assert.equal(out, `token=${CONCEALED} done`);
});

test("Scrubber conceals every value, several times, and passes other text through", async () => {
  const out = await scrub(["hunter22", "pa$$word", "abc"], ["hunter22 and pa$", "$word, hunter", "22 abc", " hunt"]);
  assert.equal(out, `${CONCEALED} and ${CONCEALED}, ${CONCEALED} abc hunt`);
});

test("Scrubber handles values with multi-byte characters split mid-character", async () => {
  const v = "clé-ünïcode";
  const b = Buffer.from(`x${v}y`);
  const out = await scrub([v], [b.subarray(0, 4), b.subarray(4, 9), b.subarray(9)]);
  assert.equal(out, `x${CONCEALED}y`);
});

test("Scrubber with no values is a pass-through", async () => {
  assert.equal(await scrub([], ["a", "b"]), "ab");
});

test("parseRunArgs splits items and command", () => {
  assert.deepEqual(parseRunArgs(["stripe", "DB=pg.url", "OPENAI_API_KEY=openai", "aws.secret", "--", "node", "x.js", "--", "y"]), {
    items: [{ name: "stripe" }, { name: "pg", env: "DB", field: "url" }, { name: "openai", env: "OPENAI_API_KEY" }, { name: "aws", field: "secret" }],
    cmd: ["node", "x.js", "--", "y"],
  });
});

test("parseRunArgs explains what is missing", () => {
  assert.throws(() => parseRunArgs(["stripe", "node"]), /put -- between/);
  assert.throws(() => parseRunArgs(["--", "node"]), /at least one item/);
  assert.throws(() => parseRunArgs(["stripe", "--"]), /no command/);
  assert.throws(() => parseRunArgs(["X=", "--", "node"]), /not an item/);
});

test("envName", () => {
  assert.equal(envName("stripe-live"), "STRIPE_LIVE");
  assert.equal(envName("openai.api key"), "OPENAI_API_KEY");
  assert.equal(envName("1password"), "_1PASSWORD");
});

test("flags parses strings, repeatable lists, booleans and positionals", () => {
  const spec = { string: ["kind", "length"], list: ["host"], boolean: ["sealed", "symbols"] };
  assert.deepEqual(flags(["name", "--kind", "login", "--host", "a.com", "--host=b.com", "--sealed", "--no-symbols", "--length=20", "more"], spec),
    { _: ["name", "more"], kind: "login", host: ["a.com", "b.com"], sealed: true, symbols: false, length: "20" });
  assert.deepEqual(flags(["a", "--", "--kind"], spec), { _: ["a", "--kind"], host: [] });
  assert.throws(() => flags(["--bogus"], spec), /unknown flag --bogus/);
  assert.throws(() => flags(["--kind"], spec), /needs a value/);
});
