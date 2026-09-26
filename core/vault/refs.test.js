// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRef, parseTemplate, templateRefs, render, parseEnvFile } from "./refs.js";
import { parseRequest, requestOrigin, candidates, formatResponse } from "./git.js";

test("refs: vault://item/field, with the field optional", () => {
  assert.deepEqual(parseRef("vault://api-token/value"), { ref: "vault://api-token/value", name: "api-token" , field: "value" });
  assert.deepEqual(parseRef(" vault://site.login "), { ref: "vault://site.login", name: "site.login" });
  for (const bad of ["vault://", "vault://a/b/c", "op://a/b", "vault://-a/b", "vault://a/b c"]) assert.throws(() => parseRef(bad), /not a vault reference/);
});

test("refs: templates, with spaces, escapes and errors", () => {
  const t = "url={{vault://db/url}}\npw={{  vault://db/password  }}\nkeep=\\{{ not.this }}\nother={{ name }}\n";
  assert.deepEqual(templateRefs(t), ["vault://db/url", "vault://db/password"]);
  assert.equal(render(t, { "vault://db/url": "U", "vault://db/password": "P" }), "url=U\npw=P\nkeep={{ not.this }}\nother={{ name }}\n");
  assert.equal(render("\\{{ vault://db/url }}", {}), "{{ vault://db/url }}", "an escaped reference is text");
  assert.throws(() => parseTemplate("a {{ vault://db/url"), /not closed/);
  assert.throws(() => parseTemplate("{{ vault://bad name }}"), /not a vault reference/);
  assert.throws(() => render("{{ vault://db/url }}", {}), /no value/);
});

test("refs: dotenv files with references", () => {
  const vars = parseEnvFile(`# comment
export DB_URL=vault://db/url
API_KEY="vault://api-token"
PLAIN=hello # trailing comment
QUOTED='a b'
MIXED=postgres://u:{{ vault://db/password }}@db.example.com/app
`);
  assert.deepEqual(vars.map(v => v.key), ["DB_URL", "API_KEY", "PLAIN", "QUOTED", "MIXED"]);
  assert.deepEqual(vars[0].refs, ["vault://db/url"]);
  assert.deepEqual(vars[1].refs, ["vault://api-token"]);
  assert.equal(vars[2].value, "hello");
  assert.equal(vars[3].value, "a b");
  assert.equal(render(vars[4].value, { "vault://db/password": "PW" }), "postgres://u:PW@db.example.com/app");
  assert.throws(() => parseEnvFile("not a line"), /line 1/);
});

test("git: the credential protocol and exact-origin matching", () => {
  const req = parseRequest("protocol=https\nhost=git.example.com\nusername=alex\ncapability[]=authtype\ncapability[]=state\n\nignored=after-blank\n");
  assert.equal(requestOrigin(req), "https://git.example.com");
  assert.deepEqual(req["capability[]"], ["authtype", "state"]);
  assert.equal(req.ignored, undefined);
  const logins = [
    { name: "a", url: "https://git.example.com/login", hosts: ["https://git.example.com"] },
    { name: "b", url: "https://git.example.com.evil.test", hosts: [] },
    { name: "c", url: "http://git.example.com", hosts: [] },
    { name: "d", url: "https://git.example.com:8443/", hosts: [] },
    { name: "e", url: "https://git.example.com/acme/app.git", hosts: [] },
  ];
  assert.deepEqual(candidates(logins, req).map(l => l.name), ["a", "e"], "same origin only: not a look-alike, not http, not another port");
  assert.deepEqual(candidates(logins, parseRequest("protocol=https\nhost=git.example.com:8443\n")).map(l => l.name), ["d"]);
  assert.deepEqual(candidates(logins, parseRequest("protocol=https\nhost=git.example.com\npath=acme/app.git\n")).map(l => l.name), ["e"], "with useHttpPath the path must match");
  assert.deepEqual(candidates(logins, parseRequest("url=https://git.example.com/acme/app.git\n")).map(l => l.name), ["e"]);
  assert.equal(requestOrigin(parseRequest("protocol=ssh\nhost=git.example.com\n")), null);
  assert.equal(formatResponse({ username: "alex", password: "x", skip: undefined }), "username=alex\npassword=x\n");
  assert.throws(() => formatResponse({ password: "a\nb" }), /newline/);
});
