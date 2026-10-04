// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { grantSecret, revokeSecret, prepareSecrets, grantedFor, ungrantedEnv, redact, checkBuildForSealed, checkBuildForSecrets, valueForms, readings, compact } from "./secrets.js";
import { person, model, SPACE, ROLES, fakeLedger } from "./test-kit.js";

const roles = { roleOf: (/** @type {string} */ id) => /** @type {any} */ (ROLES)[id] || null };
const urn = (/** @type {string} */ ref) => `vyre://${SPACE.id}/secret/${ref.replace("vault://", "")}`;
const dep = (/** @type {any} */ over = {}) => ({ id: "dep_0123456789abcdef", space: SPACE.id, name: "northwind", stage: "Draft", secrets: [], env: {}, ...over });
const throwsCode = (/** @type {() => any} */ fn, /** @type {string} */ code) => assert.throws(fn, (/** @type {any} */ e) => e.code === code, code);
const REF = "vault://harlow/stripe";
const grant = (/** @type {any} */ d, /** @type {any} */ o = {}) => grantSecret(d, REF, { by: person("per_alex"), name: "STRIPE_KEY", class: "secret", now: 5, authz: { effect: "ask", reason: "ok", decision: "d", action: "deploy.secret", resource: urn(REF) }, approval: { task: "t", outcome: "approved", by: person("per_kit"), payload_hash: "h" }, payload_hash: "h", roles, ...o });

test("a granted secret lands on that deployment only, with who and when", () => {
  const a = dep();
  const next = grant(a);
  assert.equal(next.secrets.length, 1);
  assert.deepEqual(Object.keys(next.secrets[0]).sort(), ["class", "granted_at", "granted_by", "name", "ref", "resource", "use"]);
  assert.equal(next.secrets[0].granted_by, "per_alex");
  assert.deepEqual(a.secrets, []); // not mutated
  const b = dep({ id: "dep_fedcba9876543210", previous: a.id }); // a new version inherits nothing
  assert.deepEqual(grantedFor(b, "runtime"), []);
  assert.deepEqual(grantedFor(next, "runtime").map((/** @type {any} */ s) => s.name), ["STRIPE_KEY"]);
  assert.deepEqual(grantedFor(next, "build"), []);
});

test("a secret of class secret needs a person's approval: none, a model, a non-admin, or a different plan all fail", () => {
  throwsCode(() => grant(dep(), { approval: undefined }), "needs_approval");
  throwsCode(() => grant(dep(), { approval: { task: "t", outcome: "rejected", by: person("per_kit"), payload_hash: "h" } }), "needs_approval");
  throwsCode(() => grant(dep(), { approval: { task: "t", outcome: "approved", by: model(), payload_hash: "h" } }), "model_cannot_approve");
  throwsCode(() => grant(dep(), { approval: { task: "t", outcome: "approved", by: person("per_mara"), payload_hash: "h" } }), "not_approver");
  throwsCode(() => grant(dep(), { approval: { task: "t", outcome: "approved", by: person("per_kit"), payload_hash: "other" } }), "approval_mismatch");
  // even when authorize says allow, the class decides
  throwsCode(() => grant(dep(), { approval: undefined, authz: { effect: "allow", reason: "ok", decision: "d" } }), "needs_approval");
  // a plain config value with an allow needs none
  const cfg = grant(dep(), { class: "config", approval: undefined, authz: { effect: "allow", reason: "ok", decision: "d" } });
  assert.equal(cfg.secrets[0].class, "config");
});

test("grant refusals: deny, wrong secret, bad names, space-named, duplicates, retired, other space", () => {
  throwsCode(() => grant(dep(), { authz: { effect: "deny", reason: "no_grant" } }), "forbidden");
  throwsCode(() => grant(dep(), { authz: { effect: "ask", reason: "ok", resource: urn("vault://other/key") } }), "forbidden");
  throwsCode(() => grant(dep(), { authz: { effect: "ask", reason: "ok", action: "deploy.publish" } }), "forbidden");
  for (const name of ["lower", "VYRE_TOKEN", "DATABASE_URL", "TWENTY_KEY", "A-B", ""]) throwsCode(() => grant(dep(), { name }), "bad_secret");
  throwsCode(() => grantSecret(dep(), "plain-value", /** @type {any} */ ({ by: person("per_alex"), name: "A", class: "secret", now: 1, authz: { effect: "ask" } })), "bad_secret");
  throwsCode(() => grantSecret(dep(), "vault://a/../b", /** @type {any} */ ({ by: person("per_alex"), name: "A", class: "secret", now: 1, authz: { effect: "ask" } })), "bad_secret");
  throwsCode(() => grant(dep(), { class: "weird" }), "bad_secret");
  throwsCode(() => grant(grant(dep())), "duplicate");
  throwsCode(() => grant(dep({ stage: "Retired" })), "illegal_transition");
  throwsCode(() => grant(dep(), { by: { ...person("per_alex"), space: "spc_zzzzzzzzzzzz" } }), "forbidden");
  throwsCode(() => grant(dep(), { use: ["image"] }), "bad_input");
});

test("revoke removes one; ungrantedEnv lists env that nobody granted", () => {
  const d = grant(dep({ env: { STRIPE_KEY: REF, OTHER_KEY: "vault://harlow/other" } }));
  assert.deepEqual(ungrantedEnv(d), ["OTHER_KEY"]);
  assert.deepEqual(revokeSecret(d, "STRIPE_KEY", 9).secrets, []);
  throwsCode(() => revokeSecret(d, "NOPE", 9), "not_found");
});

test("prepareSecrets writes only this deployment's grants as 0400 files and BuildKit --secret args", async () => {
  const a = grant(dep(), { use: ["build", "runtime"] });
  const b = dep({ id: "dep_fedcba9876543210" });
  /** @type {any[]} */ const writes = [];
  const io = { dir: "/run/publish-secrets", readSecret: async (/** @type {string} */ ref, /** @type {any} */ ctx) => { assert.equal(ctx.purpose, "build"); return "sk_live_FAKE1234567890"; }, writeFile: async (/** @type {string} */ p, /** @type {string} */ v, /** @type {any} */ o) => { writes.push([p, v, o.mode]); } };
  const ra = await prepareSecrets(a, "build", io);
  assert.deepEqual(ra.args, ["--secret", "id=STRIPE_KEY,src=/run/publish-secrets/dep_0123456789abcdef/STRIPE_KEY"]);
  assert.deepEqual(writes, [["/run/publish-secrets/dep_0123456789abcdef/STRIPE_KEY", "sk_live_FAKE1234567890", 0o400]]);
  assert.ok(!ra.args.join(" ").includes("sk_live"));
  const rb = await prepareSecrets(b, "build", io);
  assert.deepEqual(rb.args, []);
  assert.equal(writes.length, 1);
  // runtime-only grants are not given to the build
  assert.deepEqual((await prepareSecrets(grant(dep()), "build", io)).args, []);
  await assert.rejects(prepareSecrets(a, "build", { ...io, readSecret: async () => "" }), (/** @type {any} */ e) => e.code === "bad_secret");
});

test("redaction hides a secret in every common form", () => {
  const v = "sk_live_FAKE1234567890";
  const text = [
    `plain ${v}`, `lower ${v.toLowerCase()}`, `b64 ${Buffer.from(v).toString("base64")}`, `b64nopad ${Buffer.from(v).toString("base64").replace(/=+$/, "")}`,
    `b64url ${Buffer.from(v).toString("base64url")}`, `hex ${Buffer.from(v).toString("hex")}`, `url ${encodeURIComponent(v)}`, `json ${JSON.stringify({ k: v })}`,
  ].join("\n");
  const out = redact(text, { STRIPE_KEY: v });
  assert.ok(!out.includes(v));
  for (const f of valueForms(v)) if (f.length >= 8) assert.ok(!out.includes(f), f);
  assert.equal((out.match(/\[secret:STRIPE_KEY\]/g) || []).length >= 8, true);
  assert.equal(redact("nothing here", { A: "xyz12345" }), "nothing here");
  assert.equal(redact("a", new Map([["A", ""]])), "a");
  const key = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----";
  assert.ok(!redact(`log ${key.split("\n")[1]} end`, { KEY: key }).includes("MIIEvQ"));
});

const SSN = "123-45-6789";
const ledger = fakeLedger([SSN, "4111111111111111", "ABCD1234EFGH"]);
const out = (/** @type {string} */ text, /** @type {"files"|"logs"} */ where = "files") => where === "files" ? { files: [{ path: "index.html", content: text }] } : { files: [], logs: text };

test("sealed values are refused in every normalised form, in files and in logs", () => {
  const forms = {
    exact: `<p>${SSN}</p>`,
    spaces: "123 45 6789", dots: "123.45.6789", nospace: "ssn:123456789", words: "SSN is 123  -  45  -  6789.",
    fullwidth: "１２３-４５-６７８９",
    base64: Buffer.from(SSN).toString("base64"), base64url: Buffer.from(`id ${SSN}`).toString("base64url"), base64compact: Buffer.from("123456789").toString("base64"),
    hex: Buffer.from(SSN).toString("hex"), hexupper: Buffer.from(SSN).toString("hex").toUpperCase(),
    url: "123%2D45%2D6789", urlplus: "id=123+45+6789",
    nested: Buffer.from(Buffer.from(SSN).toString("hex")).toString("base64"),
    card: "card 4111 1111 1111 1111", cardpad: "4111-1111-1111-1111",
    case: "abcd1234efgh", caseUp: "Abcd 1234 Efgh",
    inminified: `var a="x";var t="${SSN}";`,
  };
  for (const [name, text] of Object.entries(forms)) {
    for (const where of /** @type {const} */ (["files", "logs"])) {
      const r = checkBuildForSealed(out(text, where), ledger);
      assert.equal(r.ok, false, `${name} in ${where}`);
      assert.ok(r.findings.length >= 1, name);
      assert.ok(!JSON.stringify(r).includes(SSN) && !JSON.stringify(r).includes("4111"), "a finding never carries the value");
    }
  }
  const inPath = checkBuildForSealed({ files: [{ path: `export-${SSN}.csv`, content: "x" }] }, ledger);
  assert.equal(inPath.ok, false);
  assert.equal(inPath.findings[0].where, "path");
  const bin = checkBuildForSealed({ files: [{ path: "a.bin", content: Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(SSN), Buffer.from([255])]) }] }, ledger);
  assert.equal(bin.ok, false);
  assert.equal(checkBuildForSealed(out(SSN), ledger).findings[0].class, "us-ssn");
});

test("clean output passes, including near misses and an empty ledger", () => {
  for (const text of ["<h1>Northwind Bakery</h1>", "order 123-45-6788", "phone 555-0100", "4111 1111 1111 1112", "id 12345678", "lorem ipsum ".repeat(1000), ""]) assert.equal(checkBuildForSealed(out(text), ledger).ok, true, text.slice(0, 30));
  assert.equal(checkBuildForSealed(out(SSN), fakeLedger([])).ok, true);
  assert.deepEqual(checkBuildForSealed({}, ledger), { ok: true, findings: [] });
  assert.equal(checkBuildForSealed(out(SSN), /** @type {any} */ (null)).ok, true);
});

test("an output too large to scan within the cap is refused, not waved through", () => {
  const big = "a1b2c3d4e5 ".repeat(700_000);
  const r = checkBuildForSealed(out(big), ledger);
  assert.equal(r.ok, false);
  assert.equal(r.unverifiable, true);
});

test("a granted secret baked into build output is refused, in every form", () => {
  const v = "sk_live_FAKE1234567890";
  const values = new Map([["STRIPE_KEY", v]]);
  for (const text of [v, v.toLowerCase(), Buffer.from(v).toString("base64"), Buffer.from(v).toString("hex"), encodeURIComponent(v), "sk live FAKE 1234567890", JSON.stringify({ k: v })]) {
    const r = checkBuildForSecrets({ files: [{ path: "main.js", content: `x="${text}"` }] }, values);
    assert.equal(r.ok, false, text);
    assert.equal(r.findings[0].name, "STRIPE_KEY");
    assert.ok(!JSON.stringify(r).includes(v));
  }
  assert.equal(checkBuildForSecrets({ files: [{ path: "main.js", content: "clean" }] }, values).ok, true);
});

test("readings decodes url, base64 and hex two levels deep, and ignores binary noise", () => {
  const r = readings(Buffer.from(Buffer.from("hello world 12345").toString("hex")).toString("base64"));
  assert.ok(r.some(x => x.text.includes("hello world 12345")));
  assert.ok(readings("%41%42%43 plain").some(x => x.text.startsWith("ABC")));
  assert.equal(readings("zzzz").length, 1);
  assert.equal(compact("１２-ab C"), "12abc");
});
