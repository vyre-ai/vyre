// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDERS, DEFAULT_ENDPOINTS, rotationFor, rotate, signV4 } from "./rotate.js";

// Every provider here is a fake server on 127.0.0.1 started inside the test; no request leaves the
// machine. Fake values are made at run time, so no key-shaped literal sits in the source.

const NOW = Date.parse("2026-09-27T12:00:00Z");
const HEX = "0123456789abcdef", UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
/** @param {number} n @param {string} [alphabet] */
const fake = (n, alphabet = ALNUM) => Array.from({ length: n }, () => alphabet[crypto.randomInt(alphabet.length)]).join("");

/**
 * @typedef {{ method: string, url: string, headers: http.IncomingHttpHeaders, body: string }} Req
 * @param {import("node:test").TestContext} t
 * @param {(r: Req, base: string) => [number, string, string?] | Promise<[number, string, string?]>} handler status, body, content type
 */
async function serve(t, handler) {
  /** @type {Req[]} */
  const reqs = [];
  /** @type {string[]} */
  const problems = [];
  let base = "";
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const r = { method: String(req.method), url: String(req.url), headers: req.headers, body };
    reqs.push(r);
    try {
      const [status, text, type = "application/json"] = await handler(r, base);
      res.writeHead(status, { "content-type": type });
      res.end(text);
    } catch (e) {
      problems.push(/** @type {Error} */ (e).message);
      res.writeHead(599);
      res.end();
    }
  });
  await new Promise(ok => server.listen(0, "127.0.0.1", () => ok(undefined)));
  base = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}`;
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { base, reqs, problems };
}

/** A port nothing listens on. */
async function deadBase() {
  const s = http.createServer();
  await new Promise(ok => s.listen(0, "127.0.0.1", () => ok(undefined)));
  const port = /** @type {import("node:net").AddressInfo} */ (s.address()).port;
  await new Promise(ok => s.close(() => ok(undefined)));
  return `http://127.0.0.1:${port}`;
}

/** @param {string} message @param {string[]} secrets */
function noLeak(message, secrets) {
  for (const s of secrets) assert.ok(!message.includes(s), `a secret appeared in: ${message.slice(0, 80)}`);
  assert.ok(!/fake-body-marker/.test(message), "a response body appeared in an error");
}

/** @param {() => Promise<unknown>} f */
async function thrown(f) {
  try { await f(); } catch (e) { return /** @type {Error} */ (e).message; }
  assert.fail("expected a throw");
}

// ---- SigV4 -------------------------------------------------------------------------------------

test("SigV4 matches the published AWS example (IAM ListUsers, 20150830T123600Z)", () => {
  const r = signV4({
    method: "GET", url: "https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08",
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8", Host: "iam.amazonaws.com", "X-Amz-Date": "20150830T123600Z" },
    accessKeyId: "AKIDEXAMPLE", secretAccessKey: ["wJalrXUtnFEMI", "K7MDENG+bPxRfiCYEXAMPLEKEY"].join("/"),
    region: "us-east-1", service: "iam", amzDate: "20150830T123600Z",
  });
  assert.equal(r.signature, "5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7");
  assert.equal(r.authorization, "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7");
});

// ---- AWS ---------------------------------------------------------------------------------------

/**
 * A fake IAM that checks every signature on its own (not with signV4) against the secret it
 * issued, and records which key made each call.
 * @param {import("node:test").TestContext} t @param {Map<string, string>} keys
 */
async function fakeIam(t, keys, { refuse = "" } = {}) {
  /** @type {{ action: string, by: string, params: URLSearchParams }[]} */
  const calls = [];
  const srv = await serve(t, r => {
    if (refuse) return [403, `<ErrorResponse><Error><Type>Sender</Type><Code>${refuse}</Code><Message>fake-body-marker ${[...keys.values()].join(" ")}</Message></Error></ErrorResponse>`, "text/xml"];
    assert.equal(r.method, "POST");
    assert.equal(r.url, "/");
    assert.equal(r.headers["content-type"], "application/x-www-form-urlencoded; charset=utf-8");
    const m = /^AWS4-HMAC-SHA256 Credential=([A-Z0-9]+)\/(\d{8})\/us-east-1\/iam\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/.exec(String(r.headers.authorization));
    assert.ok(m, "Authorization has the SigV4 shape");
    const [, id, date, signed, sig] = m;
    const amzDate = String(r.headers["x-amz-date"]);
    assert.match(amzDate, /^\d{8}T\d{6}Z$/);
    assert.equal(date, amzDate.slice(0, 8));
    assert.deepEqual(signed.split(";"), ["content-type", "host", "x-amz-date"]);
    const secret = keys.get(id);
    if (!secret) return [403, "<ErrorResponse><Error><Code>InvalidClientTokenId</Code></Error></ErrorResponse>", "text/xml"];
    const sha = (/** @type {string} */ s) => crypto.createHash("sha256").update(s).digest("hex");
    const canon = ["POST", "/", "", signed.split(";").map(h => `${h}:${String(r.headers[h]).trim()}\n`).join(""), signed, sha(r.body)].join("\n");
    const sts = ["AWS4-HMAC-SHA256", amzDate, `${date}/us-east-1/iam/aws4_request`, sha(canon)].join("\n");
    let k = crypto.createHmac("sha256", "AWS4" + secret).update(date).digest();
    for (const part of ["us-east-1", "iam", "aws4_request"]) k = crypto.createHmac("sha256", k).update(part).digest();
    if (crypto.createHmac("sha256", k).update(sts).digest("hex") !== sig) return [403, "<ErrorResponse><Error><Code>SignatureDoesNotMatch</Code></Error></ErrorResponse>", "text/xml"];
    const params = new URLSearchParams(r.body);
    assert.equal(params.get("Version"), "2010-05-08");
    const action = String(params.get("Action"));
    calls.push({ action, by: id, params });
    if (action === "CreateAccessKey") {
      assert.equal(params.get("UserName"), null, "no UserName: the caller's own user");
      const nid = "AKIA" + fake(16, UPPER), nsecret = fake(40);
      keys.set(nid, nsecret);
      return [200, `<CreateAccessKeyResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/">
  <CreateAccessKeyResult>
    <AccessKey>
      <UserName>kit</UserName>
      <AccessKeyId>${nid}</AccessKeyId>
      <Status>Active</Status>
      <SecretAccessKey>${nsecret}</SecretAccessKey>
      <CreateDate>2026-09-27T12:00:00Z</CreateDate>
    </AccessKey>
  </CreateAccessKeyResult>
  <ResponseMetadata><RequestId>7a62c49f-347e-4fc4-9331-6e8eEXAMPLE</RequestId></ResponseMetadata>
</CreateAccessKeyResponse>`, "text/xml"];
    }
    if (action === "DeleteAccessKey") {
      const gone = String(params.get("AccessKeyId"));
      if (!keys.delete(gone)) return [404, "<ErrorResponse><Error><Code>NoSuchEntity</Code></Error></ErrorResponse>", "text/xml"];
      return [200, "<DeleteAccessKeyResponse><ResponseMetadata><RequestId>x</RequestId></ResponseMetadata></DeleteAccessKeyResponse>", "text/xml"];
    }
    throw new Error(`unexpected action ${action}`);
  });
  return { ...srv, calls };
}

const awsItem = { name: "northwind-deploy", kind: "cloud", details: { provider: "aws" }, fields: ["access_key_id", "secret_access_key"] };

test("aws: CreateAccessKey signed with the current key; revoke deletes the old key signed with the new one", async t => {
  const oldId = "AKIA" + fake(16, UPPER), oldSecret = fake(40);
  const keys = new Map([[oldId, oldSecret]]);
  const iam = await fakeIam(t, keys);
  const out = await rotate(awsItem, { access_key_id: oldId, secret_access_key: oldSecret }, { endpoints: { aws: iam.base }, now: () => NOW });
  assert.deepEqual(iam.problems, []);
  assert.equal(iam.calls.length, 1);
  assert.deepEqual([iam.calls[0].action, iam.calls[0].by], ["CreateAccessKey", oldId]);
  assert.notEqual(out.fields.access_key_id, oldId);
  assert.equal(out.fields.secret_access_key, keys.get(out.fields.access_key_id));
  assert.equal(out.expires, undefined);
  assert.ok(keys.has(oldId), "rotate() leaves the old key alive");
  assert.equal(String(iam.reqs[0].headers["x-amz-date"]), "20260927T120000Z");

  assert.deepEqual(await out.revoke(), { revoked: true });
  assert.equal(iam.calls.length, 2);
  assert.deepEqual([iam.calls[1].action, iam.calls[1].by, iam.calls[1].params.get("AccessKeyId")], ["DeleteAccessKey", out.fields.access_key_id, oldId]);
  assert.ok(!keys.has(oldId));
  assert.deepEqual(iam.problems, []);
});

test("aws: temporary credentials are refused without a request", async t => {
  const iam = await fakeIam(t, new Map());
  const item = { ...awsItem, fields: [...awsItem.fields, "session_token"] };
  assert.equal(rotationFor(item)?.auto, false);
  const msg = await thrown(() => rotate(item, { access_key_id: "ASIA" + fake(16, UPPER), secret_access_key: fake(40), session_token: fake(60) }, { endpoints: { aws: iam.base } }));
  assert.match(msg, /^AWS: these are temporary credentials/);
  assert.equal(iam.reqs.length, 0);
});

test("aws: a refused key and a full key slot say so; revoke before the new key is live reports, never throws", async t => {
  const oldId = "AKIA" + fake(16, UPPER), oldSecret = fake(40);
  const refused = await fakeIam(t, new Map([[oldId, oldSecret]]), { refuse: "InvalidClientTokenId" });
  const msg = await thrown(() => rotate(awsItem, { access_key_id: oldId, secret_access_key: oldSecret }, { endpoints: { aws: refused.base } }));
  assert.match(msg, /^AWS: the current access key was refused; it may already be deleted or deactivated$/);
  noLeak(msg, [oldId, oldSecret]);

  const full = await fakeIam(t, new Map([[oldId, oldSecret]]), { refuse: "LimitExceeded" });
  assert.match(await thrown(() => rotate(awsItem, { access_key_id: oldId, secret_access_key: oldSecret }, { endpoints: { aws: full.base } })), /two access keys/);

  // The new key works for CreateAccessKey here, then IAM "forgets" it, as eventual consistency does.
  const keys = new Map([[oldId, oldSecret]]);
  const iam = await fakeIam(t, keys);
  const out = await rotate(awsItem, { access_key_id: oldId, secret_access_key: oldSecret }, { endpoints: { aws: iam.base } });
  keys.delete(out.fields.access_key_id);
  const r = await out.revoke();
  assert.equal(r.revoked, false);
  assert.match(String(r.reason), /not active everywhere yet/);
  assert.ok(keys.has(oldId));
});

// ---- GitLab ------------------------------------------------------------------------------------

const gitlabItem = { name: "harlow-gitlab", kind: "pat", details: { provider: "gitlab" }, fields: ["token"] };

test("gitlab: self/rotate with PRIVATE-TOKEN; the new token and its expiry; revoke makes no call", async t => {
  const old = "glpat-" + fake(20), fresh = "glpat-" + fake(20);
  const gl = await serve(t, r => {
    assert.equal(r.method, "POST");
    assert.equal(r.url, "/api/v4/personal_access_tokens/self/rotate");
    if (r.headers["private-token"] !== old) return [401, JSON.stringify({ message: "401 Unauthorized" })];
    assert.deepEqual(JSON.parse(r.body), { expires_at: "2026-12-26" });
    return [200, JSON.stringify({ id: 42, name: "harlow-ci", revoked: false, created_at: "2026-09-27T12:00:00.000Z", scopes: ["api"],
      user_id: 7, last_used_at: null, active: true, expires_at: "2026-12-26", token: fresh })];
  });
  const out = await rotate(gitlabItem, { token: old }, { endpoints: { gitlab: gl.base + "/" }, now: NOW });
  assert.deepEqual(gl.problems, []);
  assert.deepEqual(out.fields, { token: fresh });
  assert.equal(out.expires, Date.parse("2026-12-26T00:00:00Z"));
  const r = await out.revoke();
  assert.equal(r.revoked, true);
  assert.equal(gl.reqs.length, 1, "revoke() made no request");
});

test("gitlab: 401 and a missing endpoint say what to do", async t => {
  const old = "glpat-" + fake(20);
  const gl = await serve(t, () => [401, `{"message":"fake-body-marker ${old}"}`]);
  const msg = await thrown(() => rotate(gitlabItem, { token: old }, { endpoints: { gitlab: gl.base } }));
  assert.equal(msg, "GitLab: the current token was refused; it may already be revoked");
  const gone = await serve(t, () => [404, "{}"]);
  assert.match(await thrown(() => rotate(gitlabItem, { token: old }, { endpoints: { gitlab: gone.base } })), /16\.10/);
});

// ---- Cloudflare --------------------------------------------------------------------------------

test("cloudflare: verify for the id, then roll the value with the current token; revoke makes no call", async t => {
  const old = fake(40), fresh = fake(40), id = fake(32, HEX);
  const cf = await serve(t, r => {
    if (r.headers.authorization !== `Bearer ${old}`) return [401, JSON.stringify({ success: false, errors: [{ code: 1000, message: "Invalid API Token" }], messages: [], result: null })];
    if (r.method === "GET" && r.url === "/client/v4/user/tokens/verify")
      return [200, JSON.stringify({ success: true, errors: [], messages: [{ code: 10000, message: "This API Token is valid and active" }],
        result: { id, status: "active", expires_on: "2027-03-01T00:00:00Z" } })];
    if (r.method === "PUT" && r.url === `/client/v4/user/tokens/${id}/value`) {
      assert.deepEqual(JSON.parse(r.body), {});
      return [200, JSON.stringify({ success: true, errors: [], messages: [], result: fresh })];
    }
    throw new Error(`unexpected ${r.method} ${r.url}`);
  });
  const item = { name: "northwind-dns", kind: "api-key", details: { provider: "cloudflare" }, fields: ["value"] };
  const out = await rotate(item, { value: old }, { endpoints: { cloudflare: cf.base } });
  assert.deepEqual(cf.problems, []);
  assert.deepEqual(out.fields, { value: fresh });
  assert.equal(out.expires, Date.parse("2027-03-01T00:00:00Z"));
  assert.equal((await out.revoke()).revoked, true);
  assert.equal(cf.reqs.length, 2);

  // A pat keeps its value in `token`.
  const pat = await rotate({ ...item, kind: "pat", fields: ["token"] }, { token: old }, { endpoints: { cloudflare: cf.base } });
  assert.deepEqual(pat.fields, { token: fresh });
});

test("cloudflare: a refused token, and a token that may not roll itself", async t => {
  const old = fake(40), id = fake(32, HEX);
  const cf = await serve(t, () => [401, JSON.stringify({ success: false, errors: [{ code: 1000, message: "fake-body-marker " + old }] })]);
  const item = { name: "northwind-dns", kind: "api-key", details: { provider: "cloudflare" }, fields: ["value"] };
  const msg = await thrown(() => rotate(item, { value: old }, { endpoints: { cloudflare: cf.base } }));
  assert.equal(msg, "Cloudflare: the current token was refused; it may already be revoked");
  const nope = await serve(t, r => r.method === "GET" ? [200, JSON.stringify({ success: true, result: { id, status: "active" } })] : [403, "fake-body-marker"]);
  assert.match(await thrown(() => rotate(item, { value: old }, { endpoints: { cloudflare: nope.base } })), /API Tokens Write/);
});

// ---- Google Cloud ------------------------------------------------------------------------------

const EMAIL = "deploy@northwind-bakery.iam.northwind.test";

function rsa() {
  return crypto.generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
}

/**
 * A fake Google: a token endpoint that verifies each JWT against the public key of the key id it
 * names, and an IAM keys API that knows which key each token came from.
 * @param {import("node:test").TestContext} t @param {Map<string, string>} pubs kid -> public key
 */
async function fakeGoogle(t, pubs, { validBefore = "9999-12-31T23:59:59Z" } = {}) {
  /** @type {Map<string, string>} */
  const tokens = new Map();
  /** @type {{ what: string, kid: string, url: string }[]} */
  const calls = [];
  const keysPath = `/v1/projects/-/serviceAccounts/${encodeURIComponent(EMAIL)}/keys`;
  const srv = await serve(t, (r, base) => {
    if (r.method === "POST" && r.url === "/token") {
      const form = new URLSearchParams(r.body);
      assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
      const [h, c, s] = String(form.get("assertion")).split(".");
      const header = JSON.parse(Buffer.from(h, "base64url").toString()), claims = JSON.parse(Buffer.from(c, "base64url").toString());
      assert.equal(header.alg, "RS256");
      const pub = pubs.get(header.kid);
      if (!pub || !crypto.verify("sha256", Buffer.from(`${h}.${c}`), pub, Buffer.from(s, "base64url")))
        return [400, JSON.stringify({ error: "invalid_grant", error_description: "Invalid JWT Signature. fake-body-marker" })];
      assert.equal(claims.iss, EMAIL);
      assert.equal(claims.aud, `${base}/token`);
      assert.equal(claims.scope, "https://www.googleapis.com/auth/cloud-platform");
      assert.equal(claims.exp - claims.iat, 3600);
      const tok = "ya29." + fake(40);
      tokens.set(tok, header.kid);
      return [200, JSON.stringify({ access_token: tok, expires_in: 3599, token_type: "Bearer" })];
    }
    const kid = tokens.get(String(r.headers.authorization).replace(/^Bearer /, ""));
    if (!kid) return [401, JSON.stringify({ error: { code: 401, message: "fake-body-marker", status: "UNAUTHENTICATED" } })];
    if (r.method === "POST" && r.url === keysPath) {
      assert.deepEqual(JSON.parse(r.body), { privateKeyType: "TYPE_GOOGLE_CREDENTIALS_FILE" });
      calls.push({ what: "create", kid, url: r.url });
      const nk = rsa(), nkid = fake(40, HEX);
      pubs.set(nkid, nk.publicKey);
      const file = { type: "service_account", project_id: "northwind-bakery", private_key_id: nkid, private_key: nk.privateKey, client_email: EMAIL,
        client_id: "1" + fake(20, "0123456789"), auth_uri: `${base}/auth`, token_uri: `${base}/token` };
      return [200, JSON.stringify({ name: `projects/northwind-bakery/serviceAccounts/${EMAIL}/keys/${nkid}`, privateKeyType: "TYPE_GOOGLE_CREDENTIALS_FILE",
        privateKeyData: Buffer.from(JSON.stringify(file)).toString("base64"), validAfterTime: "2026-09-27T12:00:00Z", validBeforeTime: validBefore,
        keyAlgorithm: "KEY_ALG_RSA_2048", keyOrigin: "GOOGLE_PROVIDED", keyType: "USER_MANAGED" })];
    }
    if (r.method === "DELETE" && r.url.startsWith(keysPath + "/")) {
      const gone = decodeURIComponent(r.url.slice(keysPath.length + 1));
      calls.push({ what: "delete", kid, url: gone });
      return pubs.delete(gone) ? [200, "{}"] : [404, "{}"];
    }
    throw new Error(`unexpected ${r.method} ${r.url}`);
  });
  return { ...srv, calls };
}

const gcpItem = { name: "northwind-sa", kind: "cloud", details: { provider: "gcp" }, fields: ["json"] };

test("gcp: a token from a self-signed JWT, a new key from the old one, and revoke deletes the old key with the new one", async t => {
  const k = rsa(), kid = fake(40, HEX);
  const pubs = new Map([[kid, k.publicKey]]);
  const g = await fakeGoogle(t, pubs, { validBefore: "2027-09-27T12:00:00Z" });
  const json = JSON.stringify({ type: "service_account", project_id: "northwind-bakery", private_key_id: kid, private_key: k.privateKey, client_email: EMAIL, token_uri: `${g.base}/token` });
  const out = await rotate(gcpItem, { json }, { endpoints: { gcp: g.base, gcpToken: `${g.base}/token` }, now: () => NOW });
  assert.deepEqual(g.problems, []);
  const next = JSON.parse(out.fields.json);
  assert.equal(next.client_email, EMAIL);
  assert.notEqual(next.private_key_id, kid);
  assert.equal(out.expires, Date.parse("2027-09-27T12:00:00Z"));
  assert.deepEqual(g.calls, [{ what: "create", kid, url: `/v1/projects/-/serviceAccounts/${encodeURIComponent(EMAIL)}/keys` }]);
  assert.ok(pubs.has(kid), "rotate() leaves the old key alive");

  assert.deepEqual(await out.revoke(), { revoked: true });
  assert.deepEqual(g.calls[1], { what: "delete", kid: next.private_key_id, url: kid });
  assert.ok(!pubs.has(kid));
  assert.deepEqual(g.problems, []);
});

test("gcp: a refused key, and a new key Google does not accept yet", async t => {
  const k = rsa(), kid = fake(40, HEX);
  const g = await fakeGoogle(t, new Map());
  const json = JSON.stringify({ type: "service_account", private_key_id: kid, private_key: k.privateKey, client_email: EMAIL, token_uri: `${g.base}/token` });
  const msg = await thrown(() => rotate(gcpItem, { json }, { endpoints: { gcp: g.base, gcpToken: `${g.base}/token` } }));
  assert.equal(msg, "Google Cloud: the current key was refused; it may already be deleted or disabled");
  noLeak(msg, [k.privateKey, kid]);

  const pubs = new Map([[kid, k.publicKey]]);
  const ok = await fakeGoogle(t, pubs);
  const out = await rotate(gcpItem, { json }, { endpoints: { gcp: ok.base, gcpToken: `${ok.base}/token` } });
  assert.equal(out.expires, undefined, "a key with no end date has no expires");
  pubs.delete(JSON.parse(out.fields.json).private_key_id);
  const r = await out.revoke();
  assert.equal(r.revoked, false);
  assert.match(String(r.reason), /not accepted yet/);
  assert.ok(pubs.has(kid));
});

// ---- leaks -------------------------------------------------------------------------------------

test("no error or revoke reason carries an old or new secret, a header value or a body", async t => {
  const secrets = [];
  const messages = [];
  /** @param {() => Promise<unknown>} f */
  const grab = async f => { messages.push(await thrown(f)); };

  // Servers that echo everything they got, in the body and a header, with a success status and junk.
  const echo = await serve(t, r => [200, `fake-body-marker ${JSON.stringify(r.headers)} ${r.body}`, "text/plain"]);
  // And the same with a failure status.
  const echo500 = await serve(t, r => [503, `fake-body-marker ${JSON.stringify(r.headers)} ${r.body}`, "text/plain"]);
  const dead = await deadBase();

  const awsF = { access_key_id: "AKIA" + fake(16, UPPER), secret_access_key: fake(40) };
  const glF = { token: "glpat-" + fake(20) };
  const cfF = { value: fake(40) };
  const k = rsa();
  const gcF = { json: JSON.stringify({ type: "service_account", private_key_id: fake(40, HEX), private_key: k.privateKey, client_email: EMAIL }) };
  secrets.push(...Object.values(awsF), glF.token, cfF.value, k.privateKey, "PRIVATE KEY");
  const cases = [
    [awsItem, awsF, "aws"], [gitlabItem, glF, "gitlab"],
    [{ name: "c", kind: "api-key", details: { provider: "cloudflare" }, fields: ["value"] }, cfF, "cloudflare"],
    [gcpItem, gcF, "gcp"],
  ];
  for (const [item, f, p] of /** @type {Array<[any, Record<string, string>, string]>} */ (cases)) {
    for (const base of [echo.base, echo500.base, dead]) {
      const endpoints = { [p]: base, gcpToken: `${base}/token` };
      await grab(() => rotate(item, f, { endpoints }));
    }
  }
  assert.equal(messages.length, 12);
  for (const m of messages) noLeak(m, secrets);
  assert.ok(messages.some(m => /could not be reached/.test(m)));
  assert.ok(messages.some(m => /server error \(HTTP 503\)/.test(m)));
  assert.ok(messages.every(m => /^(AWS|GitLab|Cloudflare|Google Cloud): /.test(m)), "every message names its provider");

  // A new key that the provider then refuses: revoke's reason is clean too.
  const oldId = "AKIA" + fake(16, UPPER), oldSecret = fake(40);
  const keys = new Map([[oldId, oldSecret]]);
  const iam = await fakeIam(t, keys);
  const out = await rotate(awsItem, { access_key_id: oldId, secret_access_key: oldSecret }, { endpoints: { aws: iam.base } });
  keys.clear();
  const r = await out.revoke();
  assert.equal(r.revoked, false);
  noLeak(String(r.reason), [oldId, oldSecret, out.fields.access_key_id, out.fields.secret_access_key]);
});

// ---- rotationFor -------------------------------------------------------------------------------

test("rotationFor: automatic, guided, wrong shape, unknown and no provider", () => {
  assert.deepEqual(rotationFor(gitlabItem), { provider: "gitlab", auto: true, url: PROVIDERS.gitlab.url, steps: PROVIDERS.gitlab.steps });
  for (const it of [awsItem, gcpItem, { kind: "api-key", details: { provider: "cloudflare" }, fields: ["value"] }]) assert.equal(rotationFor(it)?.auto, true, JSON.stringify(it.details));

  const gh = rotationFor({ name: "alex-gh", kind: "pat", details: { provider: "github" }, fields: ["token"] });
  assert.deepEqual(gh, { provider: "github", auto: false, url: "https://github.com/settings/tokens", steps: PROVIDERS.github.steps });

  // Known automatic provider, but not a shape it can rotate: guided.
  assert.equal(rotationFor({ kind: "api-key", details: { provider: "gcp" }, fields: ["value"] })?.auto, false);
  // Twilio is guided even with every field: a Standard API key may not manage keys.
  const twilioItem = { name: "harlow-sms", kind: "api-key", details: { provider: "twilio" }, fields: ["sid", "value", "account_sid"] };
  assert.deepEqual(rotationFor(twilioItem), { provider: "twilio", auto: false, url: PROVIDERS.twilio.url, steps: PROVIDERS.twilio.steps });
  assert.equal(rotationFor({ kind: "login", details: { provider: "gitlab" }, fields: ["password"] })?.auto, false);

  assert.equal(rotationFor({ kind: "api-key", details: { provider: "juno-internal" }, fields: ["value"] }), null);
  assert.equal(rotationFor({ kind: "api-key", details: {}, fields: ["value"] }), null);
  assert.equal(rotationFor({ kind: "api-key", fields: ["value"] }), null);
  assert.equal(rotationFor({ kind: "api-key", details: { provider: "__proto__" }, fields: ["value"] }), null);
});

test("rotate refuses guided and unknown providers before any request", async () => {
  const calls = [];
  /** @type {any} */
  const spy = async () => { calls.push(1); throw new Error("no"); };
  assert.match(await thrown(() => rotate({ kind: "pat", details: { provider: "github" }, fields: ["token"] }, { token: "x" }, { fetch: spy })), /cannot be rotated automatically: Open Developer settings/);
  assert.match(await thrown(() => rotate({ kind: "pat", details: {}, fields: ["token"] }, { token: "x" }, { fetch: spy })), /names no provider/);
  assert.equal(calls.length, 0);
});

test("every provider credential-shapes.js knows has a key page and plain steps", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // The shape list itself lives in lib/credential-shapes.js.
  const src = fs.readFileSync(path.join(here, "..", "..", "lib", "credential-shapes.js"), "utf8");
  const names = src.slice(src.indexOf("NAME_PROVIDERS = {"), src.indexOf("};", src.indexOf("NAME_PROVIDERS = {")));
  const slugs = new Set([...src.matchAll(/provider: "([a-z0-9-]+)"/g), ...names.matchAll(/: "([a-z0-9]+)"/g)].map(m => m[1]));
  assert.ok(slugs.size > 40 && slugs.has("jina") && slugs.has("cloudflare"), "read credential-shapes.js's providers");
  for (const s of [...slugs, "tailscale"]) assert.ok(Object.hasOwn(PROVIDERS, s), `${s} has no entry`);
  const auto = Object.entries(PROVIDERS).filter(([, p]) => p.auto).map(([k]) => k).sort();
  assert.deepEqual(auto, ["aws", "cloudflare", "gcp", "gitlab"]);
  for (const [k, p] of Object.entries(PROVIDERS)) {
    assert.match(p.url, /^https:\/\/[a-z0-9.-]+\//, k);
    assert.ok(p.steps.length > 20 && p.steps.length < 240, k);
    assert.ok(!/[\u2014\u00a7]/.test(p.steps), k);
  }
  for (const u of Object.values(DEFAULT_ENDPOINTS)) assert.match(u, /^https:\/\//);
  const own = fs.readFileSync(path.join(here, "rotate.js"), "utf8") + fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
  assert.ok(!/[\u2014\u00a7]/.test(own), "no em dash or section sign in rotate.js or its test");
});
