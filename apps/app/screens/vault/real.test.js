// @ts-check
// Vault's real source against a fake box: the tool names and inputs, the refusal codes, and that a value comes back only from vault.reveal.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const NOW = 1_800_000_000_000;

/** A fake box with a login, a card and an api key. @param {{ reveal?: any }} [o] */
function box(o = {}) {
  /** @type {{ tool: string, input: any }[]} */
  const seen = [];
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => {
    seen.push({ tool, input });
    if (tool === "vault.list") return { data: { locked: false, personal: "none", items: [
      { name: "Gmail", kind: "login", description: "intake mail", fields: ["username", "password"], hosts: ["https://mail.google.com"], rotate: false, updated: 1, vault: "agents", grants: [{ module: "mail" }, { module: "watch", watcher: "intake", project: "juniper" }] },
      { name: "Firm Visa", kind: "card", description: "", fields: ["number"], hosts: [], rotate: false, updated: 1, vault: "personal", grants: [] },
      { name: "Stripe", kind: "api-key", description: "", fields: ["key"], url: "https://api.stripe.com/v1", hosts: [], rotate: true, why: "leaked", updated: 1, vault: "agents", unverified: true, grants: [] },
    ] } };
    if (tool === "vault.uses") return { data: { uses: [{ at: NOW - 1000, action: "fill", item: "Gmail", who: "agent:kit", ok: true }, { at: NOW - 2000, action: "fill", item: "Gmail", who: "agent:kit", ok: true }, { at: NOW - 3000, action: "reveal", item: "Gmail", who: "person", ok: false }, { at: NOW - 3 * 86_400_000, action: "fill", item: "Gmail", who: "agent:kit", ok: true }] } };
    if (tool === "vault.reveal") return o.reveal ?? { data: { name: input.name, field: input.field, value: "fake-secret-value" } };
    return { data: {} };
  };
  return { call, seen };
}

test("a name and a site are shown as a person reads them; the name that is sent is the vault's own", { skip: !strip }, async () => {
  const { displayName, fieldWord, hostWord, lineOf, toItem } = await import("./real-model.ts");
  assert.deepEqual(["username", "totp", "client_secret", "password"].map(fieldWord), ["Username", "One-time code", "Client secret", "Password"]);
  assert.equal(displayName("Airline-account"), "Airline account");
  assert.equal(displayName("stripe_live--key"), "stripe live key");
  assert.equal(hostWord("https://www.Example.com/login?x=1"), "Example.com");
  assert.equal(hostWord(""), "");
  const row = { name: "juniper-drive", kind: "login", description: "", fields: ["username", "password"], url: "https://drive.juniper.example/app", hosts: ["https://drive.juniper.example"], rotate: false, updated: 1, vault: "agents", grants: [] };
  assert.equal(lineOf(row), "drive.juniper.example");
  const item = toItem(row);
  assert.deepEqual({ id: item.id, name: item.name, title: item.title }, { id: "juniper-drive", name: "juniper-drive", title: "juniper drive" });
});

test("the list becomes tabs: logins, cards, and everything else as keys", { skip: !strip }, async () => {
  const { vaultSource } = await import("./source.ts");
  const { itemsOf, toItem } = await import("./real-model.ts");
  const b = box();
  const r = await vaultSource(b.call).listReal();
  assert.deepEqual(b.seen.map((s) => s.tool), ["vault.list"]);
  assert.deepEqual(itemsOf(r.items, "All").map((i) => i.name), ["Gmail", "Firm Visa", "Stripe"]);
  assert.deepEqual(itemsOf(r.items, "Login").map((i) => i.name), ["Gmail"]);
  assert.deepEqual(itemsOf(r.items, "Card").map((i) => i.name), ["Firm Visa"]);
  const key = itemsOf(r.items, "Key")[0];
  assert.deepEqual({ name: key.name, line: key.line, unverified: key.unverified, rotate: key.rotate }, { name: "Stripe", line: "api.stripe.com", unverified: true, rotate: true });
  assert.deepEqual(toItem(r.items[0]).grants, [{ who: "mail" }, { who: "watch/intake", project: "juniper" }]);
  assert.equal(JSON.stringify(r).includes("fake-secret-value"), false);
});

test("uses are grouped over the last day, a refused one says so", { skip: !strip }, async () => {
  const { vaultSource } = await import("./source.ts");
  const { usesLine, useCount } = await import("./real-model.ts");
  const rows = await vaultSource(box().call).usesReal("Gmail");
  assert.deepEqual(usesLine(rows, NOW).map((u) => [u.who, u.text]), [["agent:kit", "filled, 2 times today"], ["person", "revealed, refused, 1 time today"]]);
  assert.equal(useCount(rows, NOW), 2);
});

test("reveal asks vault.reveal for one named field and returns the value to the caller only", { skip: !strip }, async () => {
  const { vaultSource } = await import("./source.ts");
  const b = box();
  const v = await vaultSource(b.call).revealReal("Gmail", "password");
  assert.equal(v, "fake-secret-value");
  assert.deepEqual(b.seen, [{ tool: "vault.reveal", input: { name: "Gmail", field: "password" } }]);
});

test("a reveal the box refuses for presence keeps its code and gets plain words, never a value", { skip: !strip }, async () => {
  const { vaultSource } = await import("./source.ts");
  const { revealRefusal } = await import("./real-model.ts");
  const b = box({ reveal: { error: { code: "presence_required", message: "vault.reveal needs presence" } } });
  await assert.rejects(vaultSource(b.call).revealReal("Gmail", "password"), (/** @type {any} */ e) => {
    assert.equal(e.code, "presence_required");
    assert.match(revealRefusal(e.code, e.message), /Approve on this device/);
    return true;
  });
});

test("Remove revokes one module, and a watcher grant revokes that watcher", { skip: !strip }, async () => {
  const { vaultSource } = await import("./source.ts");
  const b = box();
  await vaultSource(b.call).revokeReal("Gmail", "watch/intake");
  await vaultSource(b.call).revokeReal("Gmail", "mail");
  assert.deepEqual(b.seen.map((s) => s.input), [{ name: "Gmail", module: "watch", watcher: "intake" }, { name: "Gmail", module: "mail" }]);
});

test("an added item is checked before the box is asked, and sent as vault.put with the host split out; state and unlock are their own calls", { skip: !strip }, async () => {
  const { vaultSource } = await import("./source.ts");
  const m = await import("./real-model.ts");
  assert.equal(m.hostOf("https://Drive.Juniper.example/login?x=1"), "drive.juniper.example");
  assert.equal(m.hostOf("not a link"), "");
  const ok = m.putInput({ kind: "login", name: " Juniper Drive ", username: "alex", secret: "pw-1", url: "https://drive.juniper.example" });
  assert.deepEqual(ok, { input: { name: "Juniper-Drive", kind: "login", fields: { username: "alex", password: "pw-1" }, url: "https://drive.juniper.example", hosts: ["drive.juniper.example"] } });
  assert.deepEqual(m.putInput({ kind: "api-key", name: "k", username: "", secret: "v", url: "" }), { input: { name: "k", kind: "api-key", fields: { value: "v" } } });
  for (const bad of [{ kind: "login", name: "", username: "", secret: "x", url: "" }, { kind: "secret", name: "n", username: "", secret: "", url: "" }, { kind: "login", name: "n", username: "", secret: "x", url: "zzz" }]) assert.ok("error" in m.putInput(/** @type {any} */ (bad)), JSON.stringify(bad));
  // a login needs its username too, and every empty required field is named under that field
  assert.deepEqual(m.putProblems({ kind: "login", name: "", username: "", secret: "", url: "zzz" }), { name: "Give it a name.", username: "Type the username.", secret: "Type the password.", url: "That is not a web address." });
  assert.deepEqual(m.putProblems({ kind: "login", name: "n", username: "  ", secret: "x", url: "" }), { username: "Type the username." });
  assert.deepEqual(m.putProblems({ kind: "api-key", name: "k", username: "", secret: "", url: "" }), { secret: "Type the value." });
  assert.deepEqual(m.putProblems({ kind: "login", name: "n", username: "a", secret: "x", url: "" }), {});
  // the vault's name rule is the box's, so what a person types is made into one instead of being refused: spaces become dashes, anything else is dropped
  assert.equal(m.slugName("  Juniper  Drive (main) "), "Juniper-Drive-main");
  assert.equal(m.slugName("Bob's card, 2026"), "Bobs-card-2026");
  assert.equal(m.slugName("!!!"), "");
  assert.deepEqual(m.putProblems({ kind: "login", name: "!!!", username: "a", secret: "x", url: "" }), { name: "Start the name with a letter or a number." });
  const b = box();
  const s = vaultSource(b.call);
  await s.putReal(/** @type {any} */ (ok).input); await s.unlockReal("pass phrase");
  assert.deepEqual(b.seen.map((x) => x.tool), ["vault.put", "vault.unlock"]);
  assert.deepEqual(b.seen[1].input, { passphrase: "pass phrase" });
  assert.equal(await vaultSource(async () => ({ error: { code: "no_such_tool", message: "x" } })).stateReal(), null);
  assert.deepEqual(await vaultSource(async () => ({ data: { locked: true, unlock: "passphrase" } })).stateReal(), { locked: true, unlock: "passphrase" });
  assert.match(m.putRefusal("presence_required", ""), /Approve on this device/);
  assert.match(m.putRefusal("wrong_passphrase", ""), /not right/);
});

import { searchItems } from "./real-model.ts";
test("search: every word must match the name, the note, the site or the kind; names first; across tabs; never a value", { skip: !Boolean(process.features.typescript) }, () => {
  const row = (name, kind, description = "", hosts = []) => ({ name, kind, description, fields: ["password"], hosts, rotate: false, updated: 1, vault: "personal", grants: [] });
  const rows = [row("Juniper Drive", "login", "Studio file share", ["drive.juniper.example"]), row("Stripe key", "api-key", "Billing", ["api.stripe.com"]), row("Corporate card", "card"), row("Drive backup", "secret", "Nightly")];
  assert.deepEqual(searchItems(rows, "drive").map((i) => i.name), ["Drive backup", "Juniper Drive"], "names that match come first");
  assert.deepEqual(searchItems(rows, "stripe billing").map((i) => i.name), ["Stripe key"]);
  assert.deepEqual(searchItems(rows, "card").map((i) => i.name), ["Corporate card"], "the kind is searched");
  assert.deepEqual(searchItems(rows, "api key").map((i) => i.name), ["Stripe key"]);
  assert.deepEqual(searchItems(rows, "   "), []);
  assert.deepEqual(searchItems(rows, "zzz"), []);
  assert.ok(searchItems(rows, "password").length === 0, "a field name is not searched");
});
