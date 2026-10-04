// @ts-check
// Vault's real source against a fake box: the tool names and inputs, the refusal codes, and that a value comes back only from vault.reveal.
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
      { name: "Gmail", kind: "login", description: "intake mail", fields: ["username", "password"], hosts: ["https://mail.google.com"], rotate: false, updated: 1, vault: "agents", grants: [{ module: "mail" }, { module: "watch", watcher: "intake", project: "harlow" }] },
      { name: "Firm Visa", kind: "card", description: "", fields: ["number"], hosts: [], rotate: false, updated: 1, vault: "personal", grants: [] },
      { name: "Stripe", kind: "api-key", description: "", fields: ["key"], url: "https://api.stripe.com/v1", hosts: [], rotate: true, why: "leaked", updated: 1, vault: "agents", unverified: true, grants: [] },
    ] } };
    if (tool === "vault.uses") return { data: { uses: [{ at: NOW - 1000, action: "fill", item: "Gmail", who: "agent:kit", ok: true }, { at: NOW - 2000, action: "fill", item: "Gmail", who: "agent:kit", ok: true }, { at: NOW - 3000, action: "reveal", item: "Gmail", who: "person", ok: false }, { at: NOW - 3 * 86_400_000, action: "fill", item: "Gmail", who: "agent:kit", ok: true }] } };
    if (tool === "vault.reveal") return o.reveal ?? { data: { name: input.name, field: input.field, value: "fake-secret-value" } };
    return { data: {} };
  };
  return { call, seen };
}

test("the list becomes tabs: logins, cards, and everything else as keys", { skip: !strip }, async () => {
  const { vaultSource } = await import("./source.ts");
  const { itemsOf, toItem } = await import("./real-model.ts");
  const b = box();
  const r = await vaultSource(b.call).listReal();
  assert.deepEqual(b.seen.map((s) => s.tool), ["vault.list"]);
  assert.deepEqual(itemsOf(r.items, "Login").map((i) => i.name), ["Gmail"]);
  assert.deepEqual(itemsOf(r.items, "Card").map((i) => i.name), ["Firm Visa"]);
  const key = itemsOf(r.items, "Key")[0];
  assert.deepEqual({ name: key.name, line: key.line, unverified: key.unverified, rotate: key.rotate }, { name: "Stripe", line: "api.stripe.com", unverified: true, rotate: true });
  assert.deepEqual(toItem(r.items[0]).grants, [{ who: "mail" }, { who: "watch/intake", project: "harlow" }]);
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
