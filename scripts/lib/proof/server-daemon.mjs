// @ts-check
// A real vyred in this process (core/daemon start, the same code the box runs) on a fresh home, started the way the installer leaves a server: no owner, a one-time setup code in its environment
// (VYRE_SETUP_CODE, the variable install-box.sh writes to vyre.env), pointing at the stand-in relay and directory. This is the fast stand-in for the real installer, used on a test box where a second
// docker stack must not be started; the installer and Mac-installer servers (server-installer.mjs, server-mac.mjs) replace it on a CI runner. It does not run the installer, so the proof says which it used.
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { start } from "../../../core/daemon/index.js";
import { HUMAN_ONLY } from "../../../core/presence/index.js";

/** Takes any presence proof: this walk is about install and pairing, not about the person's fingerprint. */
const lenient = {
  required: (/** @type {string} */ tool, /** @type {any} */ def, /** @type {any} */ input) => HUMAN_ONLY.has(tool) || Boolean(def && def.presence && (typeof def.presence.when !== "function" || input === undefined || def.presence.when(input))),
  verify: async (/** @type {any} */ { proof }) => (proof ? { ok: true, method: "passkey", keyId: proof.key || "k1" } : { ok: false, message: "needs a person", methods: ["passkey"] }),
  challenge: async () => ({ error: { code: "bad_input", message: "no challenges here" } }),
  summary: async () => "", covered: () => false, coverage: () => ({ covered: false, since: null, expires: null }),
  enrolled: /** @type {any[]} */ ([]), removed: /** @type {any[]} */ ([]),
  enroll(/** @type {any} */ k) { this.enrolled.push(k); return { id: `kh${this.enrolled.length}`, kind: k.kind, name: k.name }; },
};

/**
 * @param {{ dir: string, name?: string, code: string, relay: string, directory: string, store: "records" | "plain" }} o
 */
export async function startDaemonServer(o) {
  const root = path.join(o.dir, ".vyre");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", name: o.name || "proofbox", transcripts: [], vault: { keystore: "file" },
    network: { name: o.name || "proofbox", directory: o.directory }, names: { directory: o.directory }, relay: { enabled: true, url: o.relay }, modules: { disable: ["names", "onboard"] },
    ...(o.store === "plain" ? { store: "sqlite" } : {}) }));
  const saved = { VYRE_HOME: process.env.VYRE_HOME, VYRE_SETUP_CODE: process.env.VYRE_SETUP_CODE, VYRE_SETUP_CODE_AT: process.env.VYRE_SETUP_CODE_AT, VYRE_STORE: process.env.VYRE_STORE,
    VYRE_TAILSCALE_BIN: process.env.VYRE_TAILSCALE_BIN, VYRE_SEAL_DEV: process.env.VYRE_SEAL_DEV, VYRE_KERNEL_PATH_RULE: process.env.VYRE_KERNEL_PATH_RULE };
  process.env.VYRE_HOME = root;
  process.env.VYRE_SETUP_CODE = o.code;
  process.env.VYRE_SETUP_CODE_AT = String(Math.floor(Date.now() / 1000));
  process.env.VYRE_STORE = o.store === "plain" ? "sqlite" : "auto";
  process.env.VYRE_TAILSCALE_BIN = path.join(o.dir, "no-tailscale");
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  const logs = /** @type {string[]} */ ([]);
  const d = await start({ presence: lenient, root, log: (/** @type {any} */ m) => { logs.push(String(m)); }, kernel: true });
  const restore = () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  return {
    kind: "daemon", store: o.store, logs,
    /** The four check words the server holds for this code (what its terminal prints). */
    async words() { const r = await d.registry.call("relay.setup.status", {}, "cli"); return String(r && r.data && r.data.words || ""); },
    /** A tool call as the server's own operator (not as a paired device). @param {string} tool @param {any} [input] */
    async operator(tool, input = {}) { const r = await d.registry.call(tool, input, "cli", { proof: { method: "passkey", id: "x" } }); if (r && r.error) throw Object.assign(new Error(`${tool}: ${r.error.message}`), { code: r.error.code }); return r && r.data; },
    registry: d.registry,
    async stop() {
      try { await d.stop(); } finally { restore(); }
      // Records start a record store in docker for each space (Twenty). Take away only those this run made, found by the space ids in its own log, so a shared box keeps everything else.
      const spaces = new Set(logs.map(l => /store for (spc_[a-z2-7]{12}): provisioning/.exec(l)).filter(Boolean).map(m => /** @type {RegExpExecArray} */ (m)[1]));
      for (const sp of spaces) {
        const project = `vyre-${sp.replace(/_/g, "-")}-twenty`;
        const sh = (/** @type {string} */ c) => spawnSync("sh", ["-c", c], { stdio: "ignore" });
        sh(`docker ps -aq --filter name=${project}- | xargs -r docker rm -f`);
        sh(`docker volume ls -q --filter label=com.docker.compose.project=${project} | xargs -r docker volume rm`);
        sh(`docker network ls -q --filter label=com.docker.compose.project=${project} | xargs -r docker network rm`);
      }
    },
  };
}
