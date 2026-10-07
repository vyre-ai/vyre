// @ts-check
import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { signRequest, createS3, checkEndpoint } from "./s3.js";
import { fakeS3 } from "./testing/fake-s3.js";

test("SigV4 matches the published AWS example (GET object with a Range header)", () => {
  const r = signRequest({ method: "GET", url: "https://examplebucket.s3.amazonaws.com/test.txt", region: "us-east-1", accessKey: "AK" + "IAIOSFODNN7EXAMPLE", secretKey: "wJalrXUtnFEMI/K7MDENG/" + "bPxRfiCYEXAMPLEKEY",
    date: new Date("2013-05-24T00:00:00Z"), headers: { Range: "bytes=0-9" } });
  assert.equal(r.signature, "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  assert.match(r.headers.authorization, /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,/);
});

test("endpoints: https anywhere, plain http only on a private machine, no logins in the address", () => {
  assert.equal(checkEndpoint("https://s3.example.com").ok, true);
  assert.equal(checkEndpoint("http://127.0.0.1:9000").ok, true);
  assert.equal(checkEndpoint("http://192.168.1.20:9000").ok, true);
  assert.equal(checkEndpoint("http://s3.example.com").ok, false);
  assert.equal(checkEndpoint("ftp://x.example.com").ok, false);
  assert.equal(checkEndpoint("https://alex:pw@s3.example.com").ok, false);
  assert.equal(checkEndpoint("nonsense").ok, false);
});

test("probe: a good login passes; each failure says why and never repeats the secret", async t => {
  const fake = await fakeS3({ bucket: "harlow-backup", accessKey: "AKFAKE1", secretKey: "s3cr3t-value-123" });
  t.after(fake.close);
  const s3 = createS3();
  const base = { endpoint: fake.endpoint, bucket: "harlow-backup", region: "us-east-1", accessKey: "AKFAKE1", secretKey: "s3cr3t-value-123" };
  assert.deepEqual(await s3.probe(base), { ok: true });
  assert.match(fake.seen[0].url, /^\/harlow-backup\?list-type=2&max-keys=1$/);

  const bad = await s3.probe({ ...base, secretKey: "wrong-secret-999" });
  assert.equal(bad.ok, false);
  assert.match(/** @type {any} */ (bad).reason, /rejected the secret/);
  assert.ok(!JSON.stringify(bad).includes("wrong-secret-999"));
  assert.match(/** @type {any} */ (await s3.probe({ ...base, accessKey: "NOPE" })).reason, /does not know that access ID/);
  assert.match(/** @type {any} */ (await s3.probe({ ...base, bucket: "other-bucket" })).reason, /no bucket with that name/);
  assert.match(/** @type {any} */ (await s3.probe({ ...base, bucket: "X" })).reason, /bucket name is 3 to 63/);
  fake.setDown(true);
  assert.match(/** @type {any} */ (await s3.probe(base)).reason, /busy|problem/);
});

test("probe: an address nobody answers on, and a slow one, say so", async () => {
  const s3 = createS3({ timeoutMs: 300 });
  const r = await s3.probe({ endpoint: "http://127.0.0.1:1", bucket: "abc", region: "us-east-1", accessKey: "a", secretKey: "b" });
  assert.equal(/** @type {any} */ (r).code, "unreachable");
  assert.match(/** @type {any} */ (r).reason, /Could not reach/);
  const hang = createS3({ timeoutMs: 100, fetch: /** @type {any} */ (() => new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("t"), { name: "TimeoutError" })), 20))) });
  assert.equal(/** @type {any} */ (await hang.probe({ endpoint: "https://s3.example.com", bucket: "abc", region: "r", accessKey: "a", secretKey: "b" })).code, "timeout");
});
