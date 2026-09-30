import { test } from "node:test";
import assert from "node:assert/strict";
import { redactLinks } from "./indexer.js";

test("recall: a Tailscale sign-in link is not indexed, other text and links stay", () => {
  const t = "Open https://login.tailscale.com/a/abc123 to connect, then see https://tailscale.com/kb/1017 and http://login.tailscale.com/x?y=1.";
  const r = redactLinks(t);
  assert.ok(!r.includes("abc123") && !r.includes("y=1"));
  assert.match(r, /\[tailscale sign-in link removed\] to connect/);
  assert.ok(r.includes("https://tailscale.com/kb/1017"));
  assert.equal(redactLinks("nothing here"), "nothing here");
});

test("recall: the redaction list applies every rule, and redact and redactLinks agree", async () => {
  const { redact, REDACTIONS } = await import("./indexer.js");
  assert.ok(REDACTIONS.length >= 1 && REDACTIONS.every(r => r.re.global));
  const t = "go https://login.tailscale.com/a/zzz9 now";
  assert.equal(redact(t), redactLinks(t));
  assert.ok(!redact(t).includes("zzz9"));
});

test("recall: pasted keys, claim codes, pairing seeds and private keys are removed; hashes, paths and words stay", async () => {
  const { redact } = await import("./indexer.js");
  const key = "sk-ant-" + "a1b2c3d4e5".repeat(4), gh = "ghp_" + "Ab1".repeat(14);
  const r = redact(`use ${key} and ${gh}. claim https://x.vyre.run/setup#claim=AbC_def-123456 seed vyre-pc:AbCdEfGhIjKlMnOpQrStUv\n-----BEGIN PRIVATE KEY-----\nMIIEvQ\n-----END PRIVATE KEY----- done`);
  for (const gone of ["a1b2c3d4", "Ab1Ab1", "AbC_def", "AbCdEfGh", "MIIEvQ"]) assert.ok(!r.includes(gone), `${gone} in ${r}`);
  assert.match(r, /done$/);
  const keep = "commit 3f2a9c1e7b2d84f6a9c0e5d7b1a2c3e4f5a6b7c8 in /Users/alex/Work/harlow-site/src/components/OrderForm.tsx and README.md";
  assert.equal(redact(keep), keep);
});

test("recall: stored turns are cleaned once per redaction version, and their vectors dropped", async t => {
  const { Indexer, REDACT_VERSION } = await import("./indexer.js");
  const { open, migrate } = await import("../store/index.js");
  const { MIGRATIONS } = await import("./schema.js");
  const { tempHome } = await import("../../test/helpers.js");
  const path = await import("node:path");
  const db = open(path.join(tempHome(t), "vyre.db"));
  t.after(() => db.close());
  migrate(db, "recall", MIGRATIONS);
  const key = "sk-ant-" + "a1b2c3d4e5".repeat(4);
  const add = db.prepare("INSERT INTO recall_turns (session, seq, role, ts, text) VALUES (?,?,?,?,?)");
  add.run("s1", 0, "user", 1, `my key is ${key} ok`);
  add.run("s1", 1, "user", 2, "host harlow on netlify");
  const vec = db.prepare("INSERT INTO recall_vectors (session, seq, chunk, off, v) VALUES (?,?,?,?,?)");
  vec.run("s1", 0, 0, 0, Buffer.alloc(4)); vec.run("s1", 1, 0, 0, Buffer.alloc(4));
  const ix = new Indexer(db);
  add.run("s1", 2, "user", 3, "unrelated");
  assert.equal(ix.scrub(1), 1, "a batch of one turn cleans the first");
  assert.ok(!ix.scrubbed(), "resumable: not done after one batch");
  while (!ix.scrubbed()) ix.scrub(1);
  const rows = db.prepare("SELECT seq, text FROM recall_turns ORDER BY seq").all();
  assert.ok(!rows[0].text.includes("a1b2c3d4") && rows[0].text.endsWith("ok"));
  assert.equal(rows[1].text, "host harlow on netlify");
  assert.deepEqual(db.prepare("SELECT seq FROM recall_vectors").all().map(r => r.seq), [1], "only the cleaned turn lost its vector");
  assert.equal(db.prepare("SELECT v FROM recall_meta WHERE k = 'redact'").get().v, REDACT_VERSION);
  assert.equal(ix.scrub(), 0, "once per version");
  // A pairing ticket near its word goes; the same 43 characters elsewhere are left.
  const { redact } = await import("./indexer.js");
  const tk = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCdEf".slice(0, 43);
  assert.ok(!redact(`the wink ticket is ${tk} ok`).includes(tk));
});

test("recall: a key in a URL's query or fragment is removed, the URL stays", async () => {
  const { redact } = await import("./indexer.js");
  const key = "sk-ant-" + "a1b2c3d4e5".repeat(4);
  const r = redact(`curl https://api.northwind.example/v1/orders?page=2&api_key=${key}&x=1 and https://harlow.example/app#token=${key}.`);
  assert.ok(!r.includes("a1b2c3d4"), r);
  assert.match(r, /https:\/\/api\.northwind\.example\/v1\/orders\?page=2&api_key=\[anthropic api-key removed\]&x=1/);
  assert.equal(redact("see https://harlow.example/docs/getting-started-with-the-order-form-2026"), "see https://harlow.example/docs/getting-started-with-the-order-form-2026");
});
