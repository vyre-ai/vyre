import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { HOME, landingRoute, shouldLand } from "./landing.js";

test("a member lands on the page set for members", () => {
  assert.equal(landingRoute({ member: "/u/chats" }, "member"), "/u/chats");
  assert.equal(landingRoute({ owner: "/u/now", admin: "/u/projects", member: "/u/chats", guest: "/u/files" }, "member"), "/u/chats");
});

test("a role with no page set opens Home", () => {
  assert.equal(landingRoute({ member: "/u/chats" }, "owner"), null, "the owner has no page of their own");
  assert.equal(landingRoute({}, "member"), null);
  assert.equal(landingRoute(undefined, "member"), null);
  assert.equal(landingRoute({ member: "/u/chats" }, ""), null, "no role, no page");
});

test("the guest lands on the page set for the guest, which is the key the server sends for the kernel's temp role", () => {
  assert.equal(landingRoute({ guest: "/u/files" }, "guest"), "/u/files");
  assert.equal(landingRoute({ member: "/u/chats" }, "manager"), null, "a role with no key of its own has no page");
});

test("a value that is not a page of the app is not a landing", () => {
  assert.equal(landingRoute({ member: "https://example.com" }, "member"), null);
  assert.equal(landingRoute({ member: "/u/chats/../now" }, "member"), null);
  assert.equal(landingRoute({ member: 7 }, "member"), null);
  assert.equal(landingRoute(["/u/chats"], "member"), null);
});

test("the app replaces the route only at the start, and never a route the person chose", () => {
  assert.equal(shouldLand({ path: HOME, landing: "/u/chats", moved: false }), true);
  assert.equal(shouldLand({ path: HOME, landing: "/u/chats", moved: true }), false, "the person moved: their route stays");
  assert.equal(shouldLand({ path: "/u/settings", landing: "/u/chats", moved: false }), false, "a page they opened stays");
  assert.equal(shouldLand({ path: HOME, landing: null, moved: false }), false, "no page set: Home stays");
});
