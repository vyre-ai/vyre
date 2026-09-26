// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { of, resolve, score } from "./selector.js";

const seven = { path: "/0/2/7", role: "AXButton", name: "7", container: "keypad", frame: { x: 10, y: 10, w: 40, h: 40 } };

test("selector: records identity and keeps the path only as a tiebreak", () => {
  assert.deepEqual(of(seven), { role: "AXButton", name: "7", container: "keypad", path: "/0/2/7" });
});

test("selector: finds the same control after the tree renumbers", () => {
  const moved = [{ ...seven, path: "/0/3/7", frame: { x: 200, y: 90, w: 40, h: 40 } }, { path: "/0/3/8", role: "AXButton", name: "8" }];
  const r = resolve(of(seven), moved);
  assert.equal(r.element && r.element.path, "/0/3/7");
});

test("selector: role is a gate, so a same-named text field never matches a button", () => {
  assert.equal(score(of(seven), { path: "/0/2/7", role: "AXTextField", name: "7", container: "keypad" }), -1);
  assert.equal(resolve(of(seven), [{ path: "/0/2/7", role: "AXTextField", name: "7" }]).element, null);
});

test("selector: two equally good matches is no match, and says so", () => {
  const r = resolve({ role: "AXButton", name: "Share" }, [{ path: "/0/1", role: "AXButton", name: "Share" }, { path: "/0/2", role: "AXButton", name: "Share" }]);
  assert.equal(r.element, null);
  assert.match("why" in r ? r.why : "", /more than one/);
});

test("selector: an identifier outranks a name", () => {
  const r = resolve({ role: "AXButton", identifier: "send", name: "Send" }, [
    { path: "/0/1", role: "AXButton", name: "Send" },
    { path: "/0/2", role: "AXButton", name: "Send later", identifier: "send" },
  ]);
  assert.equal(r.element && r.element.path, "/0/2");
});

test("selector: a nameless control must agree on container and path, never on role alone", () => {
  const sel = { role: "AXTextArea", container: "scroll area", path: "/0/0/0" };
  assert.equal(resolve(sel, [{ path: "/0/0/0", role: "AXTextArea", container: "scroll area" }]).element?.path, "/0/0/0");
  assert.equal(resolve(sel, [{ path: "/0/1/0", role: "AXTextArea", container: "scroll area" }]).element, null);
  assert.equal(resolve({ role: "AXTextArea" }, [{ path: "/0", role: "AXTextArea" }]).element, null);
});
