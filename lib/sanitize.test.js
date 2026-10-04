// @ts-check
// The redactor, tested from the outside by someone trying to get past it.
//
// Two rules hold everywhere here. Every value is synthetic and built at run time from pieces,
// so this file never holds anything shaped like a real key. And no assertion message contains
// the value it checks: a failing redaction test that prints the secret has put it in CI logs.
// Messages name the KIND and nothing else.

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { redact, scan, PATTERNS } from "./sanitize.js";

const body = v => v.slice(6, 22);
const PEM = kind => "-----BEGIN " + kind + "-----";
const PEM_END = kind => "-----END " + kind + "-----";

function assertRedacted(kind, value, sentence) {
  const r = redact(sentence || `the ${kind} for staging is ${value} and it expires friday`);
  assert.ok(r.hits.length, kind + ": nothing was redacted at all");
  assert.ok(!r.text.includes(body(value)), kind + ": the value survived redaction");
  assert.match(r.text, /\[[^\]]+ redacted …[^\]]*\]/, kind + ": no marker was left behind");
  return r;
}

function assertIntact(what, text) {
  const r = redact(text);
  assert.deepEqual(r.hits, [], what + ": ordinary text was redacted");
  assert.equal(r.text, text, what + ": ordinary text was rewritten");
}

const PREFIXED = [
  ["DigitalOcean token", "dop_v1_" + "1a2b3c4d".repeat(5)],
  ["OpenAI project key", "sk-proj-" + "Zq7".repeat(16)],
  ["OpenAI legacy key", "sk-" + "Xv4".repeat(16)],
  ["Anthropic key", "sk-ant-api03-" + "Nb8".repeat(16)],
  ["GitHub personal token", "ghp_" + "Ab3".repeat(14)],
  ["GitHub OAuth token", "gho_" + "Cd5".repeat(14)],
  ["GitHub server token", "ghs_" + "Ef7".repeat(14)],
  ["AWS access key id", "AKIA" + "QRSTUVWXYZ234567"],
  ["Slack bot token", "xox" + "b-111111111111-222222222222-" + "Kd".repeat(12)],
  ["Slack user token", "xox" + "p-111111111111-" + "Mn".repeat(16)],
  ["Google API key", "AIza" + "Mn7".repeat(13)],
  ["Stripe secret key", "sk_" + "live_" + "Pv9".repeat(12)],
  ["Stripe restricted key", "rk_" + "live_" + "Qw8".repeat(12)],
  ["Stripe test key", "sk_" + "test_" + "Rt6".repeat(12)],
  ["Tailscale key", "tskey-auth-" + "Gh5".repeat(10)],
  ["SendGrid key", "SG." + "Ua2".repeat(9) + "." + "Wb6".repeat(14)],
  ["Stripe publishable key", "pk_" + "live_" + "Sx4".repeat(12)],
  ["Slack app-level token", "xapp-1-A01ABCDEF-1234567890123-" + "Pq".repeat(16)],
  ["Slack refresh token", "xoxe-1-My" + "Vb".repeat(24)],
];

for (const [kind, value] of PREFIXED) test(`sanitize: a ${kind} is redacted`, () => { assertRedacted(kind, value); });

test("sanitize: the sentence around a key still reads, and the marker keeps kind and last four", () => {
  for (const [kind, value] of PREFIXED) {
    const r = redact(`rotate the ${kind}, it is ${value}, before the release on friday`);
    assert.ok(r.text.includes("before the release on friday"), kind + ": the words after it were eaten");
    assert.ok(r.text.startsWith("rotate the"), kind + ": the words before it were eaten");
    assert.ok(r.text.includes("redacted …" + value.slice(-4)), kind + ": the marker lost its tail");
  }
});

test("sanitize: JWTs and opaque bearer tokens are redacted; a short Bearer is not", () => {
  const payload = Buffer.from('{"email":"dana@harlowlegal.com","sub":"42"}').toString("base64url");
  const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." + payload + ".Qq" + "Zx".repeat(12);
  const r = assertRedacted("JWT", jwt);
  assert.ok(!r.text.includes(payload), "JWT: the payload segment, which decodes to an address, survived");
  assertRedacted("opaque bearer", "0123456789abcdef".repeat(3), "Authorization: Bearer " + "0123456789abcdef".repeat(3));
  assertIntact("a short bearer value", "Bearer abc");
});

test("sanitize: a private key block goes whole, and an unterminated one takes the rest", () => {
  for (const kind of ["RSA PRIVATE KEY", "OPENSSH PRIVATE KEY", "EC PRIVATE KEY", "PRIVATE KEY"]) {
    const pem = PEM(kind) + "\nMIIEowIBAAKCAQEA" + "q7Rv".repeat(12) + "\n" + PEM_END(kind);
    const r = redact("paste this into the runner: " + pem + " and then restart the worker");
    assert.ok(!r.text.includes("q7Rvq7Rv"), kind + ": key material survived");
    assert.ok(r.text.includes("then restart the worker"), kind + ": the instruction after it was eaten");
  }
  const open = redact("here: " + PEM("RSA PRIVATE KEY") + "\nMIIEowIBAAKCAQEA" + "q7Rv".repeat(12));
  assert.ok(!open.text.includes("q7Rvq7Rv"), "the body of a key with no END line was indexed");
  assertIntact("a certificate", PEM("CERTIFICATE") + "\nMIIBkTCB+wIJAKZ\n" + PEM_END("CERTIFICATE"));
});

test("sanitize: a key inside JSON, YAML, a shell command, a fence or a log line is redacted", () => {
  const tok = "ghp_" + "Jq5".repeat(14);
  for (const [where, text] of [
    ["JSON", `{"github_token": "${tok}", "repo": "harlow-site"}`],
    ["YAML", `github_token: ${tok}\nrepo: harlow-site`],
    ["shell", `curl -H "Authorization: token ${tok}" https://api.github.com/user`],
    ["code fence", "```sh\nexport GH_TOKEN=" + tok + "\n```"],
    ["log line", `2026-09-24T10:00:00Z INFO auth ok token=${tok} user=alex`],
    ["parenthesised", `(see ${tok}) for the runner`],
  ]) assert.ok(!redact(text).text.includes("Jq5Jq5Jq5"), where + ": a GitHub-shaped token survived");
  const r = redact(`{"token": "${"ghp_" + "Kr6".repeat(14)}", "ok": true}`);
  assert.ok(r.text.includes('"ok": true') && r.text.includes('"token": "'), "the JSON around the value was eaten");
});

test("sanitize: opaque values behind secret-shaped names are redacted, and the name survives", () => {
  const hex = "7f3d9a1c5e8b2046d7c1a9f4e6b30258";
  for (const [what, text, secret] of [
    ["NAME=", "BILLING_AUTH_TOKEN=" + hex, hex],
    ["a prefixed password", "DB_PASSWORD=" + "hunter2seekritvalue", "hunter2seekritvalue"],
    ["export with quotes", 'export WEBHOOK_SIGNING_SECRET="whsec_' + 'aBcDeF1234567890"', "aBcDeF1234567890"],
    ["YAML", "FOO_TOKEN: " + hex, hex],
    ["JSON", '{"FOO_TOKEN": "' + hex + '"}', hex],
    ["a quoted password key", '{"password":"' + 'sup3rs3cretvalue"}', "sup3rs3cretvalue"],
    ["camelCase apiKey", "apiKey: " + hex, hex],
    ["camelCase clientSecret", "clientSecret: " + hex, hex],
    ["three segments", "HARLOW_MAIL_API_KEY=re_" + "aBcDeF1234567890xy", "aBcDeF1234567890xy"],
    ["a UUID as a token", "api_token: 550e8400-e29b-41d4-a716-446655440000", "550e8400-e29b-41d4"],
  ]) {
    const r = redact(text);
    assert.ok(r.hits.length, what + ": nothing was redacted");
    assert.ok(!r.text.includes(secret), what + ": the value survived");
  }
  assert.ok(redact("BILLING_AUTH_TOKEN=" + hex).text.startsWith("BILLING_AUTH_TOKEN="), "the variable name was eaten");
});

test("sanitize: passwords in connection strings and on command lines are redacted, the host kept", () => {
  for (const url of [
    "postgres://app:" + "hunter2seekrit@db.host:5432/prod",
    "mongodb+srv://app:" + "hunter2seekrit@cluster0.example.net/prod",
    "redis://default:" + "hunter2seekrit@cache:6379",
    "https://admin:" + "hunter2seekrit@internal.example.com/admin",
  ]) {
    const r = redact(url);
    assert.ok(!r.text.includes("hunter2seekrit"), url.split("://")[0] + ": a URL password survived");
    assert.ok(r.text.includes("@"), url.split("://")[0] + ": the URL was eaten past the password");
  }
  for (const cmd of ["mysql -u root -p" + "hunter2seekrit app_prod", "psql -p" + "hunter2seekrit -h db.host", "curl -u admin:" + "hunter2seekrit https://api.example.com"]) {
    assert.ok(!redact(cmd).text.includes("hunter2seekrit"), cmd.split(" ")[0] + ": a command-line password survived");
  }
});

test("sanitize: ordinary text that merely looks secret-adjacent is left byte for byte", () => {
  const innocent = [
    "the fix landed in 7384665aabbccddeeff00112233445566778899aa on main",
    "session 19d1d733-bbc8-4f29-863d-b7014407abea is the one Alex means",
    "it is in /home/alex/Work/harlow-site/src/intake.tsx around line 12",
    "pneumonoultramicroscopicsilicovolcanoconiosis is a real word, apparently",
    "I forgot my password and had to reset it from the phone",
    "the token expires after an hour, so the worker refreshes it",
    "the AKIA prefix is how you recognise one, not a key in itself",
    "npm install left sha512-abcdefghijklmnopqrstuvwx1234567890ABCD== in the diff",
    "https://api.example.com:8443?email=sam@northwindbakery.com",
    "git@github.com:rivera-studio/harlow-site.git",
    "java -parameters -cp . Main", "ssh -p 2222 alex@host", "mysql -u root -p app_prod",
    "KEYBOARD_LAYOUT=us-international", "token_count: 18446744073709551615", "cache_key: user-profile-12345",
    "const key = crypto.pbkdf2Sync(pw, salt, 210000, 32, 'sha512')", "const token = auth.getAccessToken()",
    "token: REMOTE_TOKEN,", "SSH_KEY_FILE=~/.ssh/id_ed25519.pub", "POSTGRES_PASSWORD_FILE: /run/secrets/db_password",
    "API_KEY=process.env.MAIL_API_KEY", "TOKEN=${GITHUB_TOKEN}", "API_KEY=<your key here>", "password: <your-password>",
    "password: xxxxxxxxxxxx", "password: [already redacted]", "| password | string | the field the form posts |",
    "write to dana@harlowlegal.com or call +1 415 555 0132",
  ];
  for (const line of innocent) assertIntact(line.slice(0, 32), line);
  const para = innocent.join("\n");
  assert.equal(redact(para).text, para, "something in the innocent set was redacted when joined");
});

test("sanitize: redaction is idempotent, and markers are never matched again", () => {
  const inputs = [...PREFIXED.map(([, v]) => `the key is ${v} ok`), "password: " + "sup3rs3cretval",
    "aws_secret_access_key=" + "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEK1"];
  for (const s of inputs) {
    const once = redact(s).text;
    assert.equal(redact(once).text, once, "a second pass changed the text (" + (redact(s).hits.join(",") || "innocent") + ")");
  }
  assert.deepEqual(scan(PREFIXED.map(([, v]) => redact(v).text).join("\n")), []);
});

test("sanitize: odd input returns something sane, and nothing is catastrophically slow", () => {
  for (const v of [null, undefined, "", 0, 42, NaN, true, false, { a: 1 }, [1, 2]]) {
    const r = redact(v);
    assert.equal(typeof r.text, "string");
    assert.ok(Array.isArray(r.hits));
  }
  for (const [what, s] of [
    ["prose", "the quick brown fox jumps over the lazy dog. ".repeat(23000)],
    ["unterminated key headers", (PEM("PRIVATE KEY") + "\n").repeat(4000) + "x".repeat(200000)],
    ["password assignments", "password=aaaaaaaaaaaa ".repeat(45000)],
    ["one enormous bearer value", "Bearer " + "a".repeat(1000000)],
  ]) {
    const t0 = Date.now();
    redact(s);
    // Genuinely a timing guarantee: catastrophic regex backtracking blows up by
    // orders of magnitude (seconds to minutes), not by a small constant factor,
    // so a generous bound (measured on this machine: under 65ms per case) still
    // catches a real ReDoS-shaped regression without flaking under load from
    // other test suites running concurrently on a shared machine.
    assert.ok(Date.now() - t0 < 5000, what + ": a megabyte took too long, which smells of backtracking");
  }
});

test("sanitize: every pattern is global and none matches the empty string", () => {
  for (const [name, re] of PATTERNS) {
    assert.ok(re.global, name + ": not global, so it would only redact the first occurrence");
    assert.ok(!new RegExp(re.source, re.flags.replace("g", "")).test(""), name + ": matches the empty string");
  }
});

test("sanitize: the redactor's own source does not read as holding credentials", () => {
  const src = fs.readFileSync(new URL("./sanitize.js", import.meta.url), "utf8");
  assert.deepEqual(src.split("\n").filter(l => scan(l).length).map(l => l.trim().slice(0, 60)), []);
});

test("sanitize: KNOWN GAP, a bare opaque string with no name or prefix is indexed", () => {
  // A bare 40-character hex string is a git SHA and a bare UUID is a session id; both appear
  // thousands of times, and a rule that caught them would shred the corpus. Pinned, so closing
  // this gap is a decision someone sees rather than a side effect.
  for (const bare of ["7f3d9a1c5e8b2046d7c1a9f4e6b30258", "550e8400-e29b-41d4-a716-446655440000"]) {
    assert.ok(redact("the value is " + bare).text.includes(bare), "GOOD NEWS, BAD TEST: bare opaque strings are now redacted");
  }
});
