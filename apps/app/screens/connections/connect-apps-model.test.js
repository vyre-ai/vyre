// @ts-check
// The Connect apps adapter: catalog to rows, the sheet each step asks for, what goes back, and the share levels in the kernel's words.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { appsOf, extraApps, sheetOf, missing, inputOf, sharesOf, granteesOf, shareChanges, shareInput, memberSharesOf, memberGrantees, levelToKernel, levelFromKernel, itemOfConnection } from "./connect-apps-model.js";

const groups = [{ group: "work", presets: [
  { id: "linear", label: "Linear", group: "work", who: "", note: "Issues", setup: "none", via: "", connected: [] },
  { id: "github", label: "GitHub", group: "work", who: "", note: "", setup: "token", via: "", connected: [{ name: "github" }] },
  { id: "slack-via", label: "Slack", group: "work", who: "", note: "", setup: "via", via: "linear", connected: [] },
  { id: "google-api", label: "Google", group: "google", who: "", note: "", setup: "app", via: "", connected: [] },
] }];

test("catalog rows: connected, one tap, setup; a via preset shows only once connected", () => {
  const a = appsOf(groups, { github: [{ who: "juno", kind: "agent", level: "fill" }] });
  assert.deepEqual(a.map((x) => [x.id, x.state, x.setup]), [["linear", "one-tap", undefined], ["github", "connected", "token"], ["google-api", "setup", "app"]]);
  assert.equal(a[1].connection, "github");
  assert.equal(a[1].shares.length, 1);
});

test("only a one-click catalog row not already listed is added", () => {
  const apps = appsOf(groups);
  const x = extraApps([{ preset: "linear", oneClick: true }, { preset: "acme", name: "Acme", oneClick: true }, { preset: "nope", oneClick: false }, { preset: "done", oneClick: true, connected: true }], apps);
  assert.deepEqual(x.map((r) => r.id), ["acme"]);
});

test("a token step asks for the token and the extra fields; nothing else is sent", () => {
  const sh = /** @type {NonNullable<ReturnType<typeof sheetOf>>} */ (sheetOf({ step: { step: "token", label: "API key", extra: [{ name: "site", label: "Site" }] } }));
  assert.equal(sh.kind, "token");
  assert.equal(missing(sh, {}), "API key is needed.");
  assert.equal(missing(sh, { token: "t" }), "Site is needed.");
  assert.deepEqual(inputOf(sh, { token: " t ", "extra.site": "a" }), { token: "t", extra: { site: "a" } });
});

test("a client step sends the id, and the secret only when typed", () => {
  const sh = /** @type {NonNullable<ReturnType<typeof sheetOf>>} */ (sheetOf({ step: { step: "client", fields: [{ name: "client_id", label: "Client ID" }, { name: "client_secret", label: "Secret", secret: true, required: false }] } }));
  assert.deepEqual(inputOf(sh, { client_id: "c" }), { app: { client_id: "c" } });
  assert.deepEqual(inputOf(sh, { client_id: "c", client_secret: "s" }), { app: { client_id: "c", client_secret: "s" } });
});

test("open shows the sign-in page; connected, via and none have no sheet", () => {
  assert.equal(sheetOf({ step: { step: "open", url: "https://v.example/auth" } })?.url, "https://v.example/auth");
  for (const s of ["connected", "via", "none"]) assert.equal(sheetOf({ step: { step: s } }), null);
  assert.equal(sheetOf(null), null);
});

test("levels map to the kernel's and back; an agent is held at use", () => {
  assert.deepEqual(["fill", "read", "edit"].map(levelToKernel), ["use", "reveal", "edit"]);
  assert.deepEqual(["use", "reveal", "edit"].map(levelFromKernel), ["fill", "read", "edit"]);
  assert.deepEqual(shareInput("github-auth", { kind: "agent", subject: "juno" }, "edit"), { name: "github-auth", kind: "agent", subject: "juno", level: "use" });
  assert.deepEqual(shareInput("github-auth", { kind: "person", subject: "p1" }, "read"), { name: "github-auth", kind: "person", subject: "p1", level: "reveal" });
  assert.equal(shareInput("github-auth", { kind: "person", subject: "p1" }, null).level, null);
});

test("shares and grantees read from vault.access.get", () => {
  const got = { people: [{ id: "p1", name: "Alex" }], access: [{ kind: "person", subject: "p1", level: "reveal" }, { kind: "agent", subject: "juno", level: "use" }, { kind: "team", subject: "t", level: "use" }] };
  assert.deepEqual(sharesOf(got).map((s) => [s.who, s.kind, s.level]), [["Alex", "person", "read"], ["juno", "agent", "fill"]]);
  assert.deepEqual(granteesOf(got, [{ name: "kit" }]).map((g) => g.kind + ":" + g.subject), ["person:p1", "agent:kit"]);
});

test("the vault item of a connection", () => assert.equal(itemOfConnection({ name: "github" }), "github-auth"));

test("share changes: an added person at Read is reveal, a raised level is sent once, a removed one is null, an agent stays use, an unknown name is left alone", () => {
  const grantees = [{ who: "Alex", subject: "p1", kind: /** @type {const} */ ("person") }, { who: "Sam", subject: "p2", kind: /** @type {const} */ ("person") }, { who: "juno", subject: "juno", kind: /** @type {const} */ ("agent") }];
  const before = [{ who: "Sam", subject: "p2", kind: /** @type {const} */ ("person"), level: "fill" }, { who: "kit", subject: "uid-9", kind: /** @type {const} */ ("agent"), level: "fill" }];
  const out = shareChanges("github-auth", before, [{ who: "Alex", level: "read" }, { who: "Sam", level: "edit" }, { who: "juno", level: "edit" }, { who: "ghost", level: "read" }], grantees);
  assert.deepEqual(out, [
    { name: "github-auth", kind: "person", subject: "p1", level: "reveal" },
    { name: "github-auth", kind: "person", subject: "p2", level: "edit" },
    { name: "github-auth", kind: "agent", subject: "juno", level: "use" },
    { name: "github-auth", kind: "agent", subject: "uid-9", level: null },
  ]);
  assert.deepEqual(shareChanges("x", before, before, grantees), []);
});

test("an agent held by its id is named through agents.list", () => {
  const got = { people: [], access: [{ kind: "agent", subject: "uid-9", level: "use" }] };
  assert.equal(sharesOf(got, [{ uid: "uid-9", name: "kit" }])[0].who, "kit");
});

test("a member's connection shares are Fill in, agents named by id, and she can stop a person already holding it", () => {
  const held = memberSharesOf({ shares: [{ kind: "person", subject: "p1", level: "use" }, { kind: "agent", subject: "uid-9", level: "use" }, { kind: "team", subject: "t" }] }, [{ uid: "uid-9", name: "kit" }]);
  assert.deepEqual(held.map((h) => [h.who, h.kind, h.level]), [["p1", "person", "fill"], ["kit", "agent", "fill"]]);
  assert.deepEqual(memberGrantees(held, [{ name: "juno" }]).map((g) => g.kind + ":" + g.subject), ["person:p1", "agent:juno"]);
});
