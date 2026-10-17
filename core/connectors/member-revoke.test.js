// @ts-check
// Removing a member's connection tells the vendor to drop the token, to the vendor's own origin and nowhere else, through a real daemon with the kernel on and a fake vendor. A member signs in to an app (dynamic
// registration, a revocation address on the vendor's own origin), then disconnects: the connection's hub row goes, the vendor's /revoke receives the refresh token once, a second server that was never the vendor's
// receives nothing, and nothing else of the member's or the owner's is touched. Written to the recipe of core/daemon/two-member-connections.test.js. It runs on CI.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";

// Presets for fakes on this machine are honoured only under this switch (production reads the shipped catalog).
process.env.VYRE_CONNECTORS_TEST_PRESETS = "1";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome, present } from "../../test/helpers.js";
import { startFakeAuthServer } from "../../lib/connectors/testing/fake-oauth.js";
import { startFakeMcpHttp } from "../mcp/testing/fake-mcp.js";
import { allowLoopbackForTests } from "../../lib/http.js";
allowLoopbackForTests();

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const BEN = "per_" + "cdefghijklmnopqrstuvwxyzab";
const PW = "a long master password for the test";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });

test("a member removing their connection sends the vendor's revoke to the vendor's own origin only, once, and takes only their own row", { timeout: 240_000 }, async t => {
  const auth = await startFakeAuthServer(t, { dcr: true, revocation: true });
  const bystander = await startFakeAuthServer(t, { dcr: true, revocation: true });   // a server that is not the vendor's: it must hear nothing
  const mcp = await startFakeMcpHttp(t, { protectedBy: auth.origin, requireAuth: h => Boolean(h) && auth.tokens.has(String(h).replace(/^Bearer /, "")) });
  const root = tempHome(t);
  const preset = { id: "fakevendor", label: "Fake Vendor", group: "work", url: mcp.url, transport: "http", who: "Anyone.", evidence: "dcr-registered", oauth: { client: "dcr" } };
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" }, connectors: { presets: [preset] } }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const K = d.kernel, OWNER = K.id.owner;
  const chain = (/** @type {string} */ p) => K.chains.fromFacts({ kind: "device", device_key_id: `d-${p.slice(4, 8)}`, person: p, path: "direct", session: "s" });
  await K.gateway.grants.setRole(chain(OWNER), { person: BEN, role: "member" }, { presence: proof() });
  const ben = (await K.surfaces.open(chain(BEN), {})).token, owner = (await K.surfaces.open(chain(OWNER), {})).token;
  const asBen = (/** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, tool.startsWith("mcp.") ? "module:connectors" : "device:abcdefghijklmnop", { token: ben, person: { id: "ps-ben", kind: "passkey" } });   // the door keeps mcp.* to the owner: a member reaches her hub row through the module that makes her connections
  const asOwner = (/** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, "cli", { token: owner });
  const step = (/** @type {string} */ name, /** @type {any} */ ok) => assert.ok(ok, name);

  step("Ben makes a vault", (await asBen("vault.me.account.create", { password: PW })).data);
  const s = await asBen("connectors.connect", { preset: "fakevendor" });
  step("Ben starts a sign-in: " + JSON.stringify(s.error || s.data), s.data && s.data.step === "open");
  const done = await asBen("connectors.connect.finish", { id: s.data.id, url: auth.consent(s.data.url) });
  step("Ben finishes it: " + JSON.stringify(done.error || done.data), done.data && done.data.step === "connected");
  const row = ((await asBen("mcp.servers")).data || []).find((/** @type {any} */ x) => x.owner === BEN);
  step("his hub row exists", row);
  step("nothing was revoked yet", auth.revocations.length === 0 && bystander.revocations.length === 0);

  const gone = await asBen("connectors.disconnect", { name: "fakevendor" });
  step("Ben disconnects: " + JSON.stringify(gone.error || gone.data), !gone.error);
  step("the answer says the vendor was told: revoked true", gone.data && gone.data.revoked === true && typeof gone.data.why === "string", JSON.stringify(gone.data));
  step("his hub row is gone", !((await asBen("mcp.servers")).data || []).some((/** @type {any} */ x) => x.owner === BEN));
  step("the vendor was told, once", auth.revocations.length === 1);
  step("with a token, and the hint that it is the refresh token", auth.revocations[0].token.length > 8 && auth.revocations[0].hint === "refresh_token");
  step("the server that is not the vendor heard nothing", bystander.revocations.length === 0 && !bystander.calls.some((/** @type {any} */ c) => c.path === "/revoke"));
  step("the owner is untouched: no connection of Ben's in the owner's list or hub", !((await asOwner("mcp.servers")).data || []).some((/** @type {any} */ x) => x.owner) && !JSON.stringify((await asOwner("connectors.list")).data || []).includes("fakevendor"));
});

test("a member removing a connection whose vendor named no revocation address is told so in the answer, and nothing is sent to the vendor", { timeout: 240_000 }, async t => {
  const auth = await startFakeAuthServer(t, { dcr: true });   // no revocation address in its discovery document
  const mcp = await startFakeMcpHttp(t, { protectedBy: auth.origin, requireAuth: h => Boolean(h) && auth.tokens.has(String(h).replace(/^Bearer /, "")) });
  const root = tempHome(t);
  const preset = { id: "fakevendor", label: "Fake Vendor", group: "work", url: mcp.url, transport: "http", who: "Anyone.", evidence: "dcr-registered", oauth: { client: "dcr" } };
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" }, connectors: { presets: [preset] } }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const K = d.kernel, OWNER = K.id.owner;
  const chain = (/** @type {string} */ p) => K.chains.fromFacts({ kind: "device", device_key_id: `d-${p.slice(4, 8)}`, person: p, path: "direct", session: "s" });
  await K.gateway.grants.setRole(chain(OWNER), { person: BEN, role: "member" }, { presence: proof() });
  const ben = (await K.surfaces.open(chain(BEN), {})).token;
  const asBen = (/** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, tool.startsWith("mcp.") ? "module:connectors" : "device:abcdefghijklmnop", { token: ben, person: { id: "ps-ben", kind: "passkey" } });   // the door keeps mcp.* to the owner: a member reaches her hub row through the module that makes her connections
  assert.ok((await asBen("vault.me.account.create", { password: PW })).data);
  const s = await asBen("connectors.connect", { preset: "fakevendor" });
  assert.equal(s.data?.step, "open", JSON.stringify(s.error || s.data));
  const done = await asBen("connectors.connect.finish", { id: s.data.id, url: auth.consent(s.data.url) });
  assert.equal(done.data?.step, "connected", JSON.stringify(done.error || done.data));
  const gone = await asBen("connectors.disconnect", { name: "fakevendor" });
  assert.equal(gone.error, undefined, JSON.stringify(gone.error));
  assert.equal(gone.data.removed, true);
  assert.equal(gone.data.revoked, false, "the answer says the vendor was not told: " + JSON.stringify(gone.data));
  assert.match(gone.data.why, /named no revocation address/);
  assert.equal(auth.revocations.length, 0);
  assert.ok(!auth.calls.some((/** @type {any} */ c) => c.path === "/revoke"));
});
