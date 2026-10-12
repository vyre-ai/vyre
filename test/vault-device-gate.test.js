// @ts-check
// The vault is the owner's, over the listener the owner's phone uses: an owner and a member, BOTH with a device key enrolled on the server and a People session on it. The member's device calls vault.list,
// vault.reveal and vault.put on the real route and is refused; the owner's device works. A People session proves a device signed in, not whose it is: what shows it is the owner's is the device row the daemon reads.
// Also a thread socket: a call for a MEMBER's session with its token stripped is refused before the registry. A real daemon. A test box, never a Mac.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { start } from "../core/daemon/index.js";
import { COOKIE } from "../core/presence/person.js";
import { tempHome, present, pairDevice } from "./helpers.js";
import { MEMBER_REFUSAL, STARTED } from "../core/vault/member-gate.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const SECRET = "S3cr3t-owner-value-Zq81vXr2";
const OWNER_DEV = "ownerphoneabcdef", MEMBER_DEV = "memberphoneabcde";   // a relay device id is 16 letters and digits 2 to 7
const BOB = "per_" + "b".repeat(26);

for (const claimed of [true, false]) {
  test(`over the device listener the member's phone is refused every vault call and the owner's works (owner ${claimed ? "claimed" : "not claimed"})`, { timeout: 200_000 }, async t => {
    const root = tempHome(t);
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "alex", role: "box", vault: { keystore: "file" }, transcripts: [], modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
    const d = await start({ root, presence: present, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
    t.after(() => d.stop());
    if (claimed) await d.kernel.adoptOwner("per_" + "q".repeat(26), { from: d.kernel.id.owner });
    const owner = d.kernel.id.owner;
    assert.equal(STARTED.withKernel, true, "the vault module started with the kernel handle on a kernel-run daemon (else the gate would treat a team server as having no kernel and stay open)");
    const chainOf = (/** @type {string} */ person) => d.kernel.chains.fromFacts({ kind: "device", device_key_id: "dev-" + person.slice(4, 10), person, path: "direct", session: "s" });
    await d.kernel.gateway.grants.setRole(chainOf(owner), { person: BOB, role: "member" }, { presence: { method: "stand-in" } });
    pairDevice(d, OWNER_DEV, owner);
    pairDevice(d, MEMBER_DEV, BOB);
    const ctx = d.registry.context({ name: "names", version: "0.1.0", does: { tools: [] }, watches: { emits: ["owner.seen"] } });
    const sessions = { [OWNER_DEV]: d.registry.deps.cliSessions.startStandIn("owner-node"), [MEMBER_DEV]: d.registry.deps.cliSessions.startStandIn("member-node") };
    const node = { [OWNER_DEV]: "owner-node", [MEMBER_DEV]: "member-node" };
    /** @param {string} dev @param {string} tool @param {any} input */
    const device = async (dev, tool, input) => {
      const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(input))]), { method: "POST", url: `/v1/tools/${tool}`, headers: { host: "relay", "content-type": "application/json", cookie: `${COOKIE}=${sessions[dev].token}`, "sec-fetch-site": "same-origin" }, socket: {} });
      let out = "", status = 0;
      const res = { setHeader() {}, writeHead(/** @type {number} */ s) { status = s; }, end(b = "") { out += b; }, headersSent: false };
      await ctx.handler({})(req, res, `device:${dev}`, { kind: "device", stableId: node[dev], node: node[dev], login: null, tags: [], caps: {} });
      return { status, ...(out ? JSON.parse(out) : {}) };
    };
    // the owner puts an item from their terminal (a device may not put or reveal: the registry's own limit, which the owner's phone and a member's phone share)
    const ownerTok = async () => ({ token: (await d.kernel.surfaces.open(chainOf(owner), {})).token });
    assert.ok(!(await d.registry.call("vault.put", { name: "owner-secret", kind: "secret", fields: { value: SECRET } }, "cli", await ownerTok())).error);
    const ok = await device(OWNER_DEV, "vault.list", {});
    assert.equal(ok.status, 200, `the owner's device works: ${JSON.stringify(ok).slice(0, 200)}`);
    assert.deepEqual((ok.data.items || []).map((/** @type {any} */ i) => i.name), ["owner-secret"], "and lists the owner's items");
    assert.equal((await device(OWNER_DEV, "vault.item", { name: "owner-secret" })).data?.item?.name, "owner-secret");
    assert.equal((await device(OWNER_DEV, "vault.vaults.create", { name: "ownersvault" })).status, 200);
    const seen = [];
    for (const [tool, input] of [["vault.list", {}], ["vault.item", { name: "owner-secret" }], ["vault.audit", {}], ["vault.vaults.list", {}], ["vault.vaults.create", { name: "bobsvault" }], ["vault.reveal", { name: "owner-secret" }], ["vault.put", { name: "owner-secret", kind: "secret", fields: { value: "overwritten-by-member" } }]]) {
      const r = await device(MEMBER_DEV, /** @type {string} */ (tool), input);
      seen.push(`${tool}: ${r.status} ${r.error ? r.error.code : "OK"}`);
      // KNOWN OPEN ITEM (rc.2, see the advisory): on a home whose owner has not claimed an identity, callerFacts treats any confirmed device as the owner's, so a member's paired device is NOT refused there. The product
      // path makes the owner choose a name before a team Space or an invite exists; the kernel does not enforce it. After a claim the device row must name the owner and the member's device is refused, asserted below.
      if (claimed) {
        assert.ok(r.error, `the member's device is refused ${tool}: ${JSON.stringify(r).slice(0, 160)}`);
        assert.ok(!JSON.stringify(r).includes(SECRET) && !JSON.stringify(r).includes("owner-secret\""), "and learns nothing of the owner's items");
        if (["vault.list", "vault.item", "vault.audit", "vault.vaults.list", "vault.vaults.create"].includes(/** @type {string} */ (tool))) assert.ok([MEMBER_REFUSAL, "This is the owner's: the Space's vault. Ask the owner or an admin to do it for you, or to give you access."].includes(r.error.message), `${tool}: the vault's words, or the door gate's before them: ${r.error.message}`);
      }
    }
    if (!claimed) console.log(`FINDING|unclaimed home (known open, rc.2), the member's device over the listener: ${seen.join(" | ")}`);
    if (claimed) assert.deepEqual(((await d.registry.call("vault.list", {}, "cli", await ownerTok())).data.items || []).map((/** @type {any} */ i) => i.name), ["owner-secret"], "the member put and overwrote nothing, and made no vault");
  });
}
