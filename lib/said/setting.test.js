import test from "node:test";
import assert from "node:assert/strict";
import { settingTo } from "./setting.js";

test("settingTo names the key, the canonical value and the level", () => {
  assert.equal(settingTo({ key: "sessions.model", value: "sonnet", level: "project", target: "northwind" }), 'sessions.model="sonnet"@project/northwind');
  assert.equal(settingTo({ key: "a.b", value: true, level: "account" }), "a.b=true@account");
  assert.equal(settingTo({ key: "a.b", reset: true, level: "account" }), "a.b=reset@account");
  assert.equal(settingTo({ key: "a.b", value: { z: 1, a: [2, { y: 1, b: 2 }] }, level: "device", target: "d1" }), 'a.b={"a":[2,{"b":2,"y":1}],"z":1}@device/d1');
  assert.notEqual(settingTo({ key: "a.b", value: true, level: "account" }), settingTo({ key: "a.b", value: false, level: "account" }), "the opposite value is another ask");
  assert.notEqual(settingTo({ key: "a.b", value: true, level: "project", target: "x" }), settingTo({ key: "a.b", value: true, level: "project", target: "y" }), "another project is another ask");
});
