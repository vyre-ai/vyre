// Who an account is signed in as: the non-secret email and org only, never a token.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tempHome } from "../../test/helpers.js";
import { readIdentity } from "./identity.js";

const jwt = claims => `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

test("identity: claude's oauthAccount and codex's id_token email, nothing else", t => {
  const home = tempHome(t);
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "dana@example.com", organizationName: "Harlow Legal", accessToken: "SECRET-CLAUDE" }, other: "x" }));
  fs.mkdirSync(path.join(home, ".codex"));
  fs.writeFileSync(path.join(home, ".codex", "auth.json"), JSON.stringify({ OPENAI_API_KEY: "SECRET-KEY", tokens: { id_token: jwt({ email: "kit@example.com", sub: "u1" }), access_token: "SECRET-ACCESS", refresh_token: "SECRET-REFRESH" } }));
  assert.deepEqual(readIdentity("claude", home), { email: "dana@example.com", org: "Harlow Legal" });
  assert.deepEqual(readIdentity("codex", home), { email: "kit@example.com" });
  assert.ok(!JSON.stringify([readIdentity("claude", home), readIdentity("codex", home)]).includes("SECRET"), "no token or key ever comes back");
  // As the script a box runs under the account's uid: one JSON line with the same two fields.
  const out = execFileSync(process.execPath, [fileURLToPath(new URL("./identity.js", import.meta.url)), "codex", home], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(out), { email: "kit@example.com" });
  assert.ok(!out.includes("SECRET"));
});

test("identity: unreadable, unknown provider or garbage is null (the card says account not identified)", t => {
  const home = tempHome(t);
  assert.equal(readIdentity("claude", home), null);
  assert.equal(readIdentity("grok", home), null);
  fs.mkdirSync(path.join(home, ".codex"));
  fs.writeFileSync(path.join(home, ".codex", "auth.json"), "not json");
  assert.equal(readIdentity("codex", home), null);
  fs.writeFileSync(path.join(home, ".codex", "auth.json"), JSON.stringify({ tokens: { id_token: "x.y.z" } }));
  assert.equal(readIdentity("codex", home), null);
});
