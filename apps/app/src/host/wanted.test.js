import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { hostWantedFor } from "./wanted.js";

test("which pages answer the first-run tools themselves: no daemon of their own, and only those", () => {
  const web = { web: true };
  assert.equal(hostWantedFor({ ...web, hostname: "web.vyre.run" }), true, "the hosted web app");
  assert.equal(hostWantedFor({ ...web, flag: "1" }), true, "a build made for it");
  assert.equal(hostWantedFor({ ...web, shell: { kind: "windows", boxless: true } }), true, "the Windows app's window, which is always the bundled page");
  assert.equal(hostWantedFor({ ...web, shell: { kind: "mac", boxless: true } }), true, "the Mac app's window with no vyred");
  assert.equal(hostWantedFor({ ...web, shell: { kind: "mac", boxless: false } }), false, "the Mac app with its own vyred answers through it");
  assert.equal(hostWantedFor({ ...web, shell: { kind: "windows" } }), false, "a shell that does not say it has no daemon");
  assert.equal(hostWantedFor({ ...web, hostname: "alex-space.vyre.run" }), false, "a server's own page");
  assert.equal(hostWantedFor({ ...web, shell: { kind: "linux", boxless: true } }), false);
  assert.equal(hostWantedFor({ web: false, hostname: "web.vyre.run", flag: "1", shell: { kind: "windows", boxless: true } }), false, "a phone");
});

test("the Windows app's window may reach what the page host calls: the relay and the names directory", () => {
  const conf = JSON.parse(fs.readFileSync(new URL("../../../../local/capsule/native-win/app/tauri.conf.json", import.meta.url), "utf8"));
  const csp = String(conf.app.security.csp);
  const connect = /connect-src ([^;]*)/.exec(csp)[1].split(" ");
  for (const need of ["https://relay.vyre.run", "wss://relay.vyre.run", "https://names.vyre.run"]) assert.ok(connect.includes(need), `connect-src lacks ${need}`);
  assert.ok(!/unsafe-eval|\*/.test(csp), "the window's policy stays narrow");
});

test("both computer apps say the one thing hostWanted reads: a window with no daemon sets `boxless` on __vyreShell", () => {
  const read = (p) => fs.readFileSync(new URL(`../../../../${p}`, import.meta.url), "utf8");
  const mac = read("local/capsule/native/Sources/Host/VyreAppWindow.swift");
  assert.match(mac, /window\.__vyreBoxless = true;/, "a window with no vyred marks itself before the bridge is made");
  assert.match(mac, /kind: "mac",\s+boxless: !!window\.__vyreBoxless/);
  assert.ok(!/Content-Security-Policy/i.test(mac), "the Mac window adds no content policy that would block the names directory");
  const win = read("local/capsule/native-win/app/src/main.rs");
  assert.match(win, /kind: "windows", boxless: \{boxless\}/);
});
