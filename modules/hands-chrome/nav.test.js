import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { requirePublicUrl } from "./nav.js";

const lookup = map => async h => { if (!(h in map)) throw Object.assign(new Error("nx"), { code: "ENOTFOUND" }); return map[h].map(address => ({ address })); };
const L = lookup({ "example.test": ["93.184.216.34"], "evil.test": ["93.184.216.34", "10.0.0.5"], "rebind.test": ["127.0.0.1"], "meta.test": ["169.254.169.254"] });
const refused = async url => { try { await requirePublicUrl(url, { lookup: L, own: [] }); return false; } catch (e) { return /** @type {any} */ (e).code === "denied"; } };

test("a model may open public web pages", async () => { await requirePublicUrl("https://example.test/a?b=1", { lookup: L, own: [] }); await requirePublicUrl("http://93.184.216.34/", { lookup: L, own: [] }); });
test("loopback, private, link-local, metadata, tailnet and mixed or rebinding names are refused", async () => {
  for (const u of ["http://127.0.0.1:7300/", "http://localhost/", "http://[::1]/", "http://[::ffff:7f00:1]/", "http://10.1.2.3/", "http://192.168.1.1/", "http://172.16.0.9/", "http://169.254.169.254/latest/meta-data/",
    "http://100.100.1.1/", "http://0.0.0.0/", "http://2130706433/", "http://0x7f.1/", "http://evil.test/", "http://rebind.test/", "http://meta.test/", "http://[fd00::1]/", "http://[fe80::1]/"]) assert.equal(await refused(u), true, u);
});
test("a name that does not resolve and a non-http scheme are refused", async () => {
  assert.equal(await refused("https://nowhere.test/"), true);
  await assert.rejects(requirePublicUrl("file:///etc/passwd", { lookup: L, own: [] }), /http\(s\)/);
  await assert.rejects(requirePublicUrl("javascript:alert(1)", { lookup: L, own: [] }));
});
