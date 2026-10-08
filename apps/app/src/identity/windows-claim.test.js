// @ts-check
// How a Windows PC claims its name (identity/windows-claim.js): the Hello passkey where the window's page is one the shell makes a passkey on and Hello is there; the shell key (the Mac's Keychain key, or Windows' held one) otherwise.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { claimRoute } from "./windows-claim.js";
import { passkeyRp } from "./passkey.js";

const yes = async () => true, no = async () => false, boom = async () => { throw new Error("no webauthn"); };

test("a Windows PC claims with Windows Hello on the bundled page and on its paired server's page, when Hello is there", async () => {
  assert.deepEqual(await claimRoute({ shell: "windows", origin: "https://vyreapp.localhost", helloAvailable: yes }), { how: "windows-hello", rp: "vyreapp.localhost" });
  assert.deepEqual(await claimRoute({ shell: "windows", origin: "https://alex.vyre.run", helloAvailable: yes }), { how: "windows-hello", rp: "alex.vyre.run" });
});

test("without Hello, or on a page the shell makes no passkey on, a Windows PC claims with the shell key as before; the Mac always does; a browser is not a shell", async () => {
  assert.deepEqual(await claimRoute({ shell: "windows", origin: "https://vyreapp.localhost", helloAvailable: no }), { how: "shell-key" });
  assert.deepEqual(await claimRoute({ shell: "windows", origin: "https://vyreapp.localhost", helloAvailable: boom }), { how: "shell-key" });
  for (const origin of ["https://example.com", "http://vyreapp.localhost", "https://evil.vyre.run.example.com", undefined]) assert.deepEqual(await claimRoute({ shell: "windows", origin, helloAvailable: yes }), { how: "shell-key" }, String(origin));
  assert.deepEqual(await claimRoute({ shell: "mac", origin: "https://vyreapp.localhost", helloAvailable: yes }), { how: "shell-key" });
  assert.deepEqual(await claimRoute({ shell: null, origin: "https://app.vyre.run", helloAvailable: yes }), { how: "other" });
});

test("the shell rule takes only the shell's own sites: a browser still gets app.vyre.run alone", () => {
  assert.equal(passkeyRp("https://alex.vyre.run"), null);
  assert.equal(passkeyRp("https://alex.vyre.run", { shell: true }), "alex.vyre.run");
  assert.equal(passkeyRp("https://vyreapp.localhost", { shell: true }), "vyreapp.localhost");
  assert.equal(passkeyRp("https://vyreapp.localhost"), null);
  assert.equal(passkeyRp("https://app.vyre.run"), "app.vyre.run");
  for (const bad of ["https://vyre.run", "https://a.vyre.run:8443", "http://a.vyre.run", "https://a.vyre.run.evil.com", "https://localhost"]) assert.equal(passkeyRp(bad, { shell: true }), null, bad);
});
