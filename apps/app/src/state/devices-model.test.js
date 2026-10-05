// @ts-check
// Devices and vault trust as data (devices-model.ts): this device's trust from the box's list and
// its own id, each row's trust control, the expiry, path and seen lines, and the vault's rows.
// Loaded through Node's type stripping, so skipped on a Node without it. The module imports
// nothing, so this runs from the repo root as well as from the app.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const load = () => import("./devices-model.ts");

const DAY = 24 * 60 * 60_000;
const NOW = Date.UTC(2026, 8, 27, 14, 22);

const web = (o = {}) => ({ id: "d-pixel", name: "Chrome on alex's Pixel 8", kind: "web", pairedAt: NOW - 2 * 3600_000, lastSeen: NOW - 60_000,
  presence: true, online: true, path: "relay", rtt: 80, trusted: false, release: "0.14.3", build: "known", expiresAt: NOW - 60_000 + 30 * DAY, ...o });
const app = (o = {}) => ({ id: "d-phone", name: "alex's iPhone", kind: "app", pairedAt: NOW - 9 * DAY, lastSeen: NOW - 4 * 60_000, presence: true,
  online: false, path: null, rtt: null, ...o });

test("trust: the native app and the box-served browser are trusted without a list", { skip: !strip }, async () => {
  const { trustOf } = await load();
  assert.equal(trustOf({ kind: "app", self: "d-phone", devices: null }), "trusted");
  assert.equal(trustOf({ kind: "app", self: "d-phone", devices: [], denied: true }), "trusted", "the app is never limited");
  assert.equal(trustOf({ kind: "web", self: null, devices: null }), "trusted", "no relay device id: the box's own origin");
});

test("trust: a paired browser is what the list says about its own id", { skip: !strip }, async () => {
  const { trustOf } = await load();
  const others = [app(), web({ id: "d-office", name: "Firefox on Juniper office PC", trusted: true })];
  assert.equal(trustOf({ kind: "web", self: "d-pixel", devices: [...others, web()] }), "untrusted");
  assert.equal(trustOf({ kind: "web", self: "d-pixel", devices: [...others, web({ trusted: true })] }), "trusted");
  assert.equal(trustOf({ kind: "web", self: "d-pixel", devices: others }), "unknown", "not listed yet");
  assert.equal(trustOf({ kind: "web", self: "d-pixel", devices: null }), "unknown", "no list yet");
  assert.equal(trustOf({ kind: "web", self: "d-office", devices: others }), "trusted", "another browser's trust is by its own id");
});

test("trust: a refused secret settles it until the list says trusted", { skip: !strip }, async () => {
  const { trustOf } = await load();
  assert.equal(trustOf({ kind: "web", self: "d-pixel", devices: null, denied: true }), "untrusted");
  assert.equal(trustOf({ kind: "web", self: "d-pixel", devices: [web({ trusted: true })], denied: true }), "trusted", "trust that lands later wins");
});

test("trust: only a browser reads a refusal as the limit", { skip: !strip }, async () => {
  const { isDenied } = await load();
  assert.equal(isDenied("web", { code: "denied" }), true);
  assert.equal(isDenied("web", { code: "no_such_tool" }), true, "WEB_DENY answers as vyred does for a tool out of reach");
  assert.equal(isDenied("web", { code: "presence_required" }), false);
  assert.equal(isDenied("web", { code: "offline" }), false);
  assert.equal(isDenied("app", { code: "denied" }), false);
  assert.equal(isDenied("web", null), false);
});

test("rows: an untrusted browser gets Trust as a secondary button, a trusted one Stop trusting as ghost", { skip: !strip }, async () => {
  const { rowChoice } = await load();
  const u = rowChoice(web(), "trusted");
  assert.equal(u.badge, "Untrusted");
  assert.equal(u.warning, null);
  assert.deepEqual(u.control, { trusted: true, label: "Trust this browser", style: "secondary", note: "Touch ID follows" });
  const t = rowChoice(web({ trusted: true }), "trusted");
  assert.equal(t.badge, "Trusted");
  assert.deepEqual(t.control, { trusted: false, label: "Stop trusting", style: "ghost", note: "One tap" });
});

test("rows: the trust note names this device's proof", { skip: !strip }, async () => {
  const { rowChoice, proofNote } = await load();
  assert.equal(proofNote("ios"), "Face ID follows");
  assert.equal(proofNote("android"), "Fingerprint follows");
  assert.equal(proofNote("web"), "Touch ID follows");
  assert.equal(rowChoice(web(), "trusted", "ios").control?.note, "Face ID follows");
  assert.equal(rowChoice(web({ trusted: true }), "trusted", "ios").control?.note, "One tap");
});

test("rows: an unknown build warns, and Trust is an outline button, never secondary", { skip: !strip }, async () => {
  const { rowChoice, UNKNOWN_BUILD } = await load();
  const r = rowChoice(web({ build: "unknown", release: "0.14.4" }), "trusted");
  assert.equal(r.badge, "Unknown build");
  assert.equal(r.warning, UNKNOWN_BUILD);
  assert.equal(r.warning, "This browser runs a build Vyre doesn't recognise. Don't trust it unless you just updated.");
  assert.equal(r.control?.style, "outline");
  assert.equal(r.control?.label, "Trust this browser");
});

test("rows: no trust controls on an untrusted browser, and none for apps", { skip: !strip }, async () => {
  const { rowChoice } = await load();
  assert.equal(rowChoice(web(), "untrusted").control, null, "the box refuses trust from it");
  assert.equal(rowChoice(web({ trusted: true }), "untrusted").control, null);
  assert.equal(rowChoice(web(), "untrusted").badge, "Untrusted", "the state still shows");
  assert.deepEqual(rowChoice(app(), "trusted"), { badge: null, warning: null, control: null });
});

test("expiry: from the box's setting, else from expiresAt and the last visit", { skip: !strip }, async () => {
  const { expiryText, expiryDays } = await load();
  assert.equal(expiryText(web()), "Expires after 30 days unused");
  assert.equal(expiryText(web({ lastSeen: null, expiresAt: NOW - 2 * 3600_000 + 14 * DAY })), "Expires after 14 days unused", "never seen: from pairing");
  assert.equal(expiryText(web(), 45), "Expires after 45 days unused", "the setting wins");
  assert.equal(expiryText(web({ expiresAt: NOW - 60_000 + DAY })), "Expires after 1 day unused");
  assert.equal(expiryText(app()), null, "apps do not expire");
  assert.equal(expiryDays(web({ expiresAt: undefined })), null);
});

test("lines: kind, path and last seen", { skip: !strip }, async () => {
  const { kindText, pathText, seenText, powersText } = await load();
  assert.equal(kindText(web()), "Browser");
  assert.equal(kindText(app()), "App");
  assert.equal(pathText(web()), "Relay · 80 ms");
  assert.equal(pathText(web({ rtt: null })), "Relay");
  assert.equal(pathText(app({ path: "direct", rtt: 12, online: true })), "Tailscale · direct 12 ms");
  assert.equal(pathText(app()), "Not connected");
  assert.equal(seenText(web(), NOW), "Seen now");
  assert.equal(seenText(app(), NOW), "Seen 4 min ago");
  assert.equal(seenText(app({ lastSeen: NOW - 3 * 3600_000 }), NOW), "Seen 3 h ago");
  assert.equal(seenText(app({ lastSeen: NOW - 3 * DAY }), NOW), "Seen 3 days ago");
  assert.equal(powersText(web()), "Limited: no vault secrets, can't add devices");
  assert.equal(powersText(web({ trusted: true })), "Trusted · full powers of your app");
  assert.equal(powersText(app()), null);
});

test("how: names this browser as the Mac's Devices lists it", { skip: !strip }, async () => {
  const { howText } = await load();
  assert.equal(howText("Chrome on alex's Pixel 8"), "On your Mac: Devices, Chrome on alex's Pixel 8, Trust");
  assert.equal(howText(""), "On your Mac: Devices, this browser, Trust");
});

test("reopened: only a stream that comes back open after it was not", { skip: !strip }, async () => {
  const { reopened } = await load();
  assert.equal(reopened("reconnecting", "open"), true, "the channel closed on trust changed and came back");
  assert.equal(reopened("connecting", "open"), true);
  assert.equal(reopened("open", "open"), false);
  assert.equal(reopened(null, "open"), false, "the first open is not a change");
  assert.equal(reopened("open", "reconnecting"), false);
});

test("vault: rows are names, kinds and sites, never a value", { skip: !strip }, async () => {
  const { readVault, vaultDetail, siteOf, fieldsOf, fieldLabel, kindLabel, vaultFooter } = await load();
  const v = readVault({
    locked: false,
    items: [
      { name: "Northwind orders", kind: "login", fields: ["username", "password"], url: "https://app.northwind.test/login", hosts: [] },
      { name: "Juniper Studio Google", kind: "totp", fields: ["totp"], hosts: ["accounts.juniper.example"] },
      { name: "Juniper intake API key", kind: "api-key", fields: [], hosts: ["https://intake.juniper.example"] },
      { name: "Juniper Wi-Fi", kind: "note" },
      null,
      { kind: "login" },
    ],
  });
  assert.equal(v.items.length, 4, "rows without a name are dropped");
  assert.equal(vaultDetail(v.items[0]), "Login · app.northwind.test");
  assert.equal(vaultDetail(v.items[1]), "Code · accounts.juniper.example");
  assert.equal(vaultDetail(v.items[2]), "API key · intake.juniper.example");
  assert.equal(vaultDetail(v.items[3]), "Note");
  assert.equal(siteOf(v.items[3]), null);
  assert.deepEqual(fieldsOf(v.items[0]), ["username", "password"]);
  assert.deepEqual(fieldsOf(v.items[2]), ["value"], "no field names: the one value");
  assert.equal(fieldLabel("password"), "Password");
  assert.equal(fieldLabel("totp"), "One-time code");
  assert.equal(kindLabel("ssh-key"), "SSH key");
  assert.equal(kindLabel("weird-kind"), "Weird kind");
  assert.equal(vaultFooter(214), "214 items · names, kinds and sites sync here");
  assert.equal(JSON.stringify(v).includes("value\":"), false);
  assert.deepEqual(readVault(null), { locked: false, items: [] });
});

test("devices: the list keeps only rows with an id and a name", { skip: !strip }, async () => {
  const { readDevices } = await load();
  assert.deepEqual(readDevices({ devices: [web(), { id: 3 }, null, app()] }).map((d) => d.id), ["d-pixel", "d-phone"]);
  assert.deepEqual(readDevices(undefined), []);
});
