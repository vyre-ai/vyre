// @ts-check
// A Mac paired to a server, in one process: a real box vyred and a real Mac vyred in temp homes. The Mac's wink module holds a paired-server record (the rows pairing writes) and its open
// peer session is a function into the box's registry as the Mac's device (core/wink/serverlink.js peerSeams), so wink.server.home and wink.server.call work exactly as on a paired Mac, with no relay.
// `awayNow()` makes the server unreachable, the way a closed lid or a dropped network does.
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { peerSeams } from "../core/wink/serverlink.js";
import { tempHome, present, deviceFor } from "./helpers.js";

/**
 * @param {{ after: (fn: () => any) => void, name?: string }} t
 * @param {{ boxName?: string, macHost?: string }} [o]
 */
export async function pair(t, o = {}) {
  const boxRoot = tempHome(/** @type {any} */ (t));
  fs.writeFileSync(path.join(boxRoot, "config.json"), JSON.stringify({ name: o.boxName || "kit-box", role: "box", transcripts: [] }));
  const box = await start({ root: boxRoot, presence: present, log: () => {} });
  t.after(() => box.stop());
  const macRoot = tempHome(/** @type {any} */ (t));
  fs.writeFileSync(path.join(macRoot, "config.json"), JSON.stringify({ name: o.macHost || "test-mac", role: "local", machine: "device", transcripts: [] }));
  const mac = await start({ root: macRoot, presence: present, log: () => {} });
  t.after(() => mac.stop());

  // The Mac's paired-server record: the device row and the channel the pairing leaves.
  // The identity this Mac answers for: the owner record a pairing leaves (wink.js owner1 reads it first).
  const identity = "per_seamharnessseamharness";
  const sid = deviceFor("server-" + (o.boxName || "kit-box")).slice("device:".length);
  const db = mac.registry.deps.db;
  db.prepare("INSERT OR REPLACE INTO wink_meta (k, v) VALUES ('owner', ?)").run(JSON.stringify({ identity, kind: "identity", id: identity, name: "Alex" }));
  db.prepare("INSERT INTO wink_devices (id, identity, kind, name, owner_kind, owner_id, created) VALUES (?, ?, 'server', ?, 'identity', ?, ?)").run(sid, identity, o.boxName || "kit-box", identity, Date.now());
  db.prepare("INSERT INTO wink_meta (k, v) VALUES (?, ?)").run(`channel:${sid}`, JSON.stringify({ relay: "ws://seam.invalid", route: "seam", box: "seam" }));
  db.prepare("INSERT INTO wink_meta (k, v) VALUES (?, ?)").run(`paired:${sid}`, JSON.stringify({ at: Date.now() }));

  // What the box sees of this Mac: its device, acting for the box's owner (the stand-in proof a development build takes).
  fs.writeFileSync(path.join(boxRoot, "dev-presence-stand-in"), "walk\n");
  const deviceId = deviceFor("mac-" + (o.macHost || "test-mac")).slice("device:".length);
  try { box.registry.deps.db.prepare("INSERT OR IGNORE INTO relay_devices (id, name, pub, paired_at, kind, trusted, removed_at) VALUES (?, ?, 'p', 1, 'app', 0, NULL)").run(deviceId, o.macHost || "test-mac"); } catch { /* no relay table */ }
  const meta = { proof: { method: "stand-in" }, kernel_proof: { method: "stand-in" }, kernelFacts: { kind: "device", device_key_id: deviceId, person: box.kernel.id.owner, path: "relay", session: "ps_seam" } };
  const state = { away: false };
  peerSeams.set(macRoot, (/** @type {string} */ s) => s !== sid ? null : ({
    closed: false,
    call: async (/** @type {string} */ tool, /** @type {any} */ input = {}) => {
      if (state.away) throw Object.assign(new Error("the server could not be reached"), { code: "unreachable" });
      const r = await box.registry.call(tool, input, `device:${deviceId}`, meta);
      if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
      return r.data;
    },
    close() {},
  }));
  t.after(() => peerSeams.delete(macRoot));
  return {
    box, mac, boxRoot, macRoot, sid,
    boxCall: (/** @type {string} */ tool, input = {}, caller = "cli") => box.registry.call(tool, input, caller),
    macCall: (/** @type {string} */ tool, input = {}, caller = "cli") => mac.registry.call(tool, input, caller),
    awayNow: () => { state.away = true; },
    backNow: () => { state.away = false; },
  };
}
