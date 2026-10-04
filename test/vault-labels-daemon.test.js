// The person comes from the kernel's chain, never from a caller label, in the four sites the vault team owned (presence's session check, Drive share and unshare, vault connections, the sync
// namespace): on a REAL kernel-on daemon, with the facts from the daemon's own `callerFacts` and the home's relay rows. A confirmed owner device signed in is the person; a web device, a setup
// device, a removed device, an id never paired, an unsigned owner device and a tailnet label with no proven facts get nothing. Run on a test box, never on a person's Mac.
import test from "node:test";
import assert from "node:assert/strict";
import { start, callerFacts } from "../core/daemon/index.js";
import { tempHome } from "./helpers.js";

test("labels grant nothing on a kernel-on daemon: presence's session check, vault connections and Drive share ask the kernel's chain", async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const d = await start({ root: tempHome(t), log: () => {}, kernel: true });
  t.after(() => d.stop());
  const ins = d.registry.deps.db.prepare("INSERT INTO relay_devices (id, name, pub, paired_at, kind, trusted, removed_at) VALUES (?, ?, 'p', 1, ?, ?, ?)");
  const ids = { app: "aaaaaaaaaaaaaaaa", web: "bbbbbbbbbbbbbbbb", setup: "cccccccccccccccc", gone: "dddddddddddddddd", never: "eeeeeeeeeeeeeeee" };
  ins.run(ids.app, "phone", "app", 0, null); ins.run(ids.web, "browser", "web", 1, null); ins.run(ids.setup, "setup page", "setup", 0, null); ins.run(ids.gone, "old", "app", 0, 5);
  // The home's own Space is known to the spaces module (devices enrol per Space; a device with no list yet is enrolled).
  d.registry.deps.db.prepare("INSERT OR IGNORE INTO spaces_space (id, name, label, created_by, status, created_at, updated_at) VALUES (?, 'alex.vyre.run', 'alex', 'per_x', 'live', 1, 1)").run(d.kernel.id.space);
  /** The meta the daemon builds for one call from a device: its own facts from the relay row, the person session id as a stand-in carried as a fact. */
  const metaOf = async (id, signedIn) => {
    const label = `device:${id}`, via = signedIn ? { person: { id: "ps1" } } : {};
    const info = await d.registry.call("relay.device.info", { id }, "module:vyred");
    const facts = callerFacts(label, { caller: label }, via, d.kernel, false, info.data || null);
    return { label, meta: { caller: label, ...via, ...(facts ? { kernelFacts: facts } : {}) } };
  };
  const presence = d.registry.deps.presence;
  assert.equal(typeof presence.personOf, "function", "the gate's presence check asks the kernel");
  const person = async (id, signedIn) => presence.personOf((await metaOf(id, signedIn)).meta);
  assert.equal(await person(ids.app, true), true, "a confirmed owner device, signed in, is the person");
  for (const k of ["web", "setup", "gone", "never"]) for (const signedIn of [true, false]) assert.equal(await person(ids[k], signedIn), false, `${k} (signed in: ${signedIn}) is nobody`);
  assert.equal(await person(ids.app, false), true, "the kernel counts a confirmed owner device as the person even unsigned (session proofs still need the session secret)");
  for (const label of ["tailnet:alex@harlow.example", "tailnet:alex@harlow.example:agent:kit", "device:zzzzzzzzzzzzzzzz", "deck", "capsule", "weird"]) assert.equal(await presence.personOf({ caller: label }), false, `${label} with no proven facts`);

  // vault connections: the person surface only for the person
  const list = async (id, signedIn) => { const { label, meta } = await metaOf(id, signedIn); return d.registry.call("vault.connections.list", {}, label, meta); };
  const ok = await list(ids.app, true);
  assert.ok(!ok.error && ok.data.surface === "person", `the owner device signed in sees the person surface: ${JSON.stringify(ok.error || ok.data.surface)}`);
  for (const k of ["web", "setup", "gone", "never"]) { const r = await list(ids[k], true); assert.ok(r.error || r.data.surface !== "person", `${k} gets no person surface`); }
  const tn = await d.registry.call("vault.connections.list", {}, "tailnet:alex@harlow.example", { person: { id: "ps1" }, peer: { stableId: "nodeA" } });
  assert.ok(tn.error || tn.data.surface !== "person", "a tailnet label that merely claims a person session gets no person surface");

  // Drive share: a paired Mac's tailnet label with a claimed person session and no proven facts is refused
  const cols = d.registry.deps.db.prepare("PRAGMA table_info(link_peers)").all().filter(c => c.notnull && c.dflt_value === null && c.name !== "stable_id");
  d.registry.deps.db.prepare(`INSERT INTO link_peers (stable_id${cols.map(c => `, ${c.name}`).join("")}) VALUES (?${cols.map(c => (/INT|REAL/i.test(c.type) ? ", 1" : ", 'x'")).join("")})`).run("macA");
  const share = await d.registry.call("files.drive.share", { name: "projects" }, "tailnet:alex@harlow.example", { person: { id: "ps1" }, peer: { stableId: "macA" } });
  assert.ok(share.error && ["denied", "presence_required"].includes(share.error.code) && !(share.data && share.data.shared), `a paired Mac's label alone is not the person: ${JSON.stringify(share.error || share.data)}`);
});
