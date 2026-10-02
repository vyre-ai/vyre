// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { installDom } from "../chat/lib/test-dom.js";

installDom();
const { grantFromHash, enrollUrl, takeGrant } = await import("./enroll-grant.js");
const G = "A".repeat(43);

test("grantFromHash: only a well-formed #enroll= grant", () => {
  assert.equal(grantFromHash(`#enroll=${G}`), G);
  for (const bad of ["", "#", "#enroll=", "#enroll=short", `#enroll=${G}&x=1`, `#other=${G}`, `#enroll=${"!".repeat(43)}`, `#enroll=${G}${"A".repeat(200)}`]) assert.equal(grantFromHash(bad), null, bad);
});

test("enrollUrl: your server's own host and the grant in the fragment, nothing else", () => {
  assert.equal(enrollUrl({ grant: G, rpId: "Alex.vyre.run" }), `https://alex.vyre.run/#enroll=${G}`);
  assert.equal(enrollUrl({ grant: G, rpId: "evil.com/x" }), null);
  assert.equal(enrollUrl({ grant: G, rpId: "a.b:8080" }), null);
  assert.equal(enrollUrl({ grant: "no", rpId: "alex.vyre.run" }), null);
  assert.equal(enrollUrl(/** @type {any} */ (null)), null);
});

test("takeGrant reads the grant and removes it from the address at once", () => {
  /** @type {any[]} */ const calls = [];
  const g = takeGrant({ hash: `#enroll=${G}`, pathname: "/now", search: "?a=1" }, { replaceState: (...a) => calls.push(a) });
  assert.equal(g, G);
  assert.deepEqual(calls, [[null, "", "/now?a=1"]]);
  const none = /** @type {any[]} */ ([]);
  assert.equal(takeGrant({ hash: "#/devices", pathname: "/", search: "" }, { replaceState: (...a) => none.push(a) }), null);
  assert.equal(none.length, 0, "an ordinary hash is left alone");
  // A malformed enroll fragment is still stripped, so a bad grant does not sit in history.
  assert.equal(takeGrant({ hash: "#enroll=bad", pathname: "/", search: "" }, { replaceState: (...a) => none.push(a) }), null);
  assert.equal(none.length, 1);
});
