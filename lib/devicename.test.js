import test from "node:test";
import assert from "node:assert/strict";
import { friendlyDeviceName } from "./devicename.js";

test("devicename: what a device calls itself becomes a name a person reads, never .local or localhost", () => {
  const f = (raw, o) => friendlyDeviceName(raw, o);
  assert.equal(f("Alex's MacBook Pro"), "Alex's MacBook Pro", "a good name is kept as it is");
  assert.equal(f("alexs-macbook-pro.local"), "alexs macbook pro", "the suffix goes, the dashes read as spaces");
  assert.equal(f("Alexs-MacBook-Pro.lan"), "Alexs MacBook Pro");
  assert.equal(f("mac.local", { kind: "mac", owner: "Alex Smith" }), "Alex's Mac");
  assert.equal(f("localhost", { kind: "phone", owner: "Alex" }), "Alex's phone");
  assert.equal(f("localhost", { kind: "web" }), "Browser");
  assert.equal(f("", { kind: "device", owner: "" }), "Device");
  assert.equal(f("192.168.1.5"), "Device");
  assert.equal(f("alex-vyre"), "alex-vyre", "a dashed name that is not a kind of device is the person's own");
  assert.equal(f("x".repeat(100)).length, 64);
  assert.equal(f("a\u0000b\nc"), "a b c");
});
