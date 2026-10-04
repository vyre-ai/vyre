// @ts-check
// Two real identities on one stand-in names directory, for a walk or a test that needs a second person (an invitee, a member's device): the shape windows' member-device test in
// test/one-registry.test.js and core/stream/e2e-step7-vyred.js use. TEST ONLY: a throwaway directory process (scripts/standin-directory.mjs, its storage kept in `state` so a restart keeps
// every claim) and a second home that claims a name at it with spaces.identity.create.
//
//   const dir = await startDirectory({ state: path.join(root, "dir-state.bin") });            // { port, url, stop() }
//   const carol = await claimInHome({ root: carolRoot, name: "carolwalk", directory: dir.url }); // { id, eid, name }
//   // then, in the host's home: insert the verified name row an invite redemption writes, so the Space can find her list:
//   //   db.prepare("INSERT OR REPLACE INTO spaces_kv (key, value) VALUES (?, ?)").run(`person-name/${carol.id}`, JSON.stringify(carol.name));
//   // her device's facts for a call are { kind: "device", device_key_id: carol.eid, person: carol.id, path: "wink" }.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { start } from "../../daemon/index.js";
import { call } from "../../daemon/client.js";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts", "standin-directory.mjs");
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = /** @type {any} */ (s.address()).port; s.close(() => res(p)); }); });

/** @param {{ state?: string, claimsPerIp?: number }} [o] @returns {Promise<{ port: number, url: string, stop: () => void }>} */
export async function startDirectory(o = {}) {
  const port = await freePort();
  const args = [SCRIPT, "--port", String(port), "--claims-per-ip", String(o.claimsPerIp ?? 50), ...(o.state ? ["--state", o.state] : [])];
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((res, rej) => { child.stdout.on("data", d => { if (String(d).includes("stand-in names directory")) res(null); }); child.on("exit", c => rej(new Error(`the stand-in directory exited early (${c})`))); });
  const stop = () => { try { child.kill("SIGTERM"); } catch { /* gone */ } };
  process.on("exit", stop);
  return { port, url: `http://127.0.0.1:${port}`, stop };
}

/** A home of its own that claims `name` at the directory. @param {{ root: string, name: string, directory: string }} o @returns {Promise<{ id: string, eid: string, name: string }>} */
export async function claimInHome({ root, name, directory }) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: `${name}-home`, transcripts: [], vault: { keystore: "file" }, names: { directory }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  const daemon = await start({ root, kernel: true, log: () => {} });
  try {
    const made = /** @type {any} */ (await call("spaces.identity.create", { name }, { root, caller: "cli" }));
    if (made.error) throw new Error(`${name}: ${JSON.stringify(made.error)}`);
    return { id: made.data.id, eid: made.data.eid, name };
  } finally { await daemon.stop(); }
}
