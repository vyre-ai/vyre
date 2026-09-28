// @ts-check
// tailnet: the relay introduces, Tailscale carries (ADR 0046). Two halves, one file:
//
// The box's half talks to the Tailscale API with the minting OAuth client (vault item MINT_ITEM):
// a single-use, pre-approved, 5-minute auth key tagged tag:vyre-device for one paired desktop,
// and deleting that device's node on revoke. Nothing here is a tool: core/relay/index.js calls it
// straight from the pairing channel, so no script, agent or ctx.call can mint a key by itself.
//
// The desktop's half runs `tailscale up` with that key. The key never touches argv or the
// environment (ps shows both to every process at this uid, reviewer's HIGH): it goes in a 0600
// file inside a fresh 0700 directory, passed as --auth-key=file:<path>, and the directory is
// removed the moment the command returns, success or not. A desktop already signed in to any
// tailnet is left alone: joining would switch the person's own Tailscale account.
//
// Every outbound dependency is injected: tests use useTailscaleApi() and a fake tailscale binary,
// never api.tailscale.com or a real `tailscale up`.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { connect } from "../../relay/client/client.js";
import { nodeCrypto, fileKeyStore } from "../../relay/client/nodecrypto.js";

export const MINT_ITEM = "tailscale-mint-oauth";
export const DEVICE_TAG = "tag:vyre-device";
export const KEY_TTL_S = 300;
/** The one channel path a paired desktop asks its box for a key on; answered before the router, never a tool. */
export const JOIN_PATH = "/v1/relay/tailnet/key";
const API = "https://api.tailscale.com";
const NODE_ID = /^[A-Za-z0-9]{1,64}$/;

const fail = (code, message) => Object.assign(new Error(message), { code });

/** @type {{ fetch?: typeof fetch, base?: string } | null} */
let testApi = null;
/**
 * Tests only: point the box's Tailscale API calls at a fake. Returns the undo.
 * @param {{ fetch?: typeof fetch, base?: string }} o
 */
export function useTailscaleApi(o) {
  const was = testApi;
  testApi = o;
  return () => { testApi = was; };
}

/**
 * The minting credential, as the vault holds it: JSON { client_id, client_secret }.
 * @param {any} raw
 */
export function parseCredential(raw) {
  let c = raw;
  if (typeof raw === "string") { try { c = JSON.parse(raw); } catch { c = null; } }
  const id = c && typeof c.client_id === "string" ? c.client_id.trim() : "";
  const secret = c && typeof c.client_secret === "string" ? c.client_secret.trim() : "";
  if (!id || !secret) throw fail("not_set_up", `the vault item ${MINT_ITEM} needs {"client_id":"...","client_secret":"..."} from a Tailscale OAuth client`);
  return { id, secret };
}

/**
 * A Tailscale API client for one credential. `credential` is fetched per call, never cached here.
 * @param {{ credential: () => Promise<any> }} o
 */
export function tailscaleApi({ credential }) {
  const f = () => (testApi && testApi.fetch) || globalThis.fetch;
  const base = () => (testApi && testApi.base) || API;
  async function token() {
    const { id, secret } = parseCredential(await credential());
    const res = await f()(`${base()}/api/v2/oauth/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: "client_credentials" }).toString(),
    });
    if (!res.ok) throw fail("mint_failed", `Tailscale refused the OAuth client (${res.status})`);
    const b = /** @type {any} */ (await res.json());
    if (!b || typeof b.access_token !== "string") throw fail("mint_failed", "Tailscale's OAuth answer had no token");
    return b.access_token;
  }
  const call = async (method, p, body) => {
    const t = await token();
    return f()(`${base()}${p}`, { method, headers: { authorization: `Bearer ${t}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  };
  return {
    /**
     * One auth key for one paired device: single use, pre-approved, not ephemeral, tagged
     * tag:vyre-device, gone in 5 minutes (ADR 0046 section 3, the reviewer's answers 1 and 2).
     * @param {string} device the relay device id, for the key's description only
     */
    async mintKey(device) {
      const res = await call("POST", "/api/v2/tailnet/-/keys", {
        capabilities: { devices: { create: { reusable: false, ephemeral: false, preauthorized: true, tags: [DEVICE_TAG] } } },
        expirySeconds: KEY_TTL_S,
        description: `vyre device ${String(device).replace(/[^a-z0-9]/gi, "").slice(0, 16)}`,
      });
      if (!res.ok) throw fail("mint_failed", `Tailscale would not make an auth key (${res.status}); the OAuth client needs auth_keys for ${DEVICE_TAG}`);
      const b = /** @type {any} */ (await res.json());
      if (!b || typeof b.key !== "string" || !b.key) throw fail("mint_failed", "Tailscale's answer had no key");
      return { key: b.key, expiresAt: Date.parse(b.expires) || Date.now() + KEY_TTL_S * 1000 };
    },
    /** Delete one node. A node that is already gone counts as deleted. @param {string} nodeId */
    async deleteNode(nodeId) {
      if (!NODE_ID.test(String(nodeId))) throw fail("bad_input", "not a Tailscale node id");
      const res = await call("DELETE", `/api/v2/device/${nodeId}`);
      if (!res.ok && res.status !== 404) throw fail("revoke_failed", `Tailscale would not delete node ${nodeId} (${res.status}); the OAuth client needs devices:core for ${DEVICE_TAG}`);
      return true;
    },
    /** The node ids on the tailnet that the credential can see. */
    async nodeIds() {
      const res = await call("GET", "/api/v2/tailnet/-/devices");
      if (!res.ok) throw fail("list_failed", `Tailscale would not list devices (${res.status})`);
      const b = /** @type {any} */ (await res.json());
      return new Set((Array.isArray(b && b.devices) ? b.devices : []).map(d => String(d.nodeId || "")).filter(Boolean));
    },
  };
}

// ---- the desktop's half ----

/** Same rule as core/link/transport.js's tailscaleBin: VYRE_TAILSCALE_BIN wins, and a test gets none. */
function bin() {
  if (process.env.VYRE_TAILSCALE_BIN) return process.env.VYRE_TAILSCALE_BIN;
  if (process.env.NODE_TEST_CONTEXT && process.env.VYRE_TEST_REAL_TAILSCALE !== "1") return null;
  const app = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
  return process.platform === "darwin" && fs.existsSync(app) ? app : "tailscale";
}

/** @returns {Promise<{ code: number, out: string, err: string }>} */
function run(args, timeout = 15_000) {
  const b = bin();
  if (!b) return Promise.resolve({ code: 127, out: "", err: "no tailscale binary in tests" });
  return new Promise(resolve => {
    execFile(b, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (e, out, err) => {
      const code = !e ? 0 : /** @type {any} */ (e).code === "ENOENT" ? 127 : Number(/** @type {any} */ (e).code) || 1;
      resolve({ code, out: String(out), err: String(err) });
    });
  });
}

/** The install line to show when Tailscale is missing (core/names/tailscale.js's installCommand, kept equal by a test). */
export function installCommand(platform = process.platform) {
  if (platform === "linux") return "curl -fsSL https://tailscale.com/install.sh | sh";
  if (platform === "darwin") return "open https://tailscale.com/download/mac";
  return "open https://tailscale.com/download";
}

/**
 * Whether this desktop can take a key: Tailscale installed, and not signed in to any tailnet.
 * @returns {Promise<{ ready: true } | { ready: false, why: "not_installed"|"already_on_a_tailnet"|"unknown", install?: string, node?: string }>}
 */
export async function canJoin() {
  const r = await run(["status", "--json"]);
  if (r.code === 127) return { ready: false, why: "not_installed", install: installCommand() };
  let s = null;
  try { s = JSON.parse(r.out); } catch {}
  if (!s) return r.code === 0 ? { ready: false, why: "unknown" } : { ready: true };
  const state = String(s.BackendState || "");
  if (state === "Running" || (s.Self && s.Self.ID && state !== "NeedsLogin" && state !== "NoState" && state !== "Stopped")) {
    return { ready: false, why: "already_on_a_tailnet", node: String((s.Self && s.Self.HostName) || "") };
  }
  return { ready: true };
}

/**
 * `tailscale up` with a key that never reaches argv or the environment.
 * @param {string} key
 * @param {{ hostname?: string, tmp?: string, timeout?: number }} [o]
 * @returns {Promise<{ joined: boolean, stableId?: string, node?: string, why?: string }>}
 */
export async function joinWithKey(key, o = {}) {
  if (typeof key !== "string" || !/^tskey-[A-Za-z0-9-]+$/.test(key)) return { joined: false, why: "not a Tailscale auth key" };
  const dir = fs.mkdtempSync(path.join(o.tmp || os.tmpdir(), "vyre-ts-"));
  let r;
  try {
    fs.chmodSync(dir, 0o700);
    const file = path.join(dir, "key");
    fs.writeFileSync(file, key, { mode: 0o600, flag: "wx" });
    const args = ["up", `--auth-key=file:${file}`, `--advertise-tags=${DEVICE_TAG}`];
    if (o.hostname && /^[a-z0-9-]{1,63}$/i.test(o.hostname)) args.push(`--hostname=${o.hostname}`);
    r = await run(args, o.timeout || 60_000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (r.code === 127) return { joined: false, why: "not_installed" };
  if (r.code !== 0) return { joined: false, why: `tailscale up failed: ${(r.err || r.out).trim().slice(0, 200)}` };
  const st = await run(["status", "--json"]);
  let s = null;
  try { s = JSON.parse(st.out); } catch {}
  const self = s && s.Self;
  if (!self || !self.ID) return { joined: false, why: "tailscale up returned but this machine has no node" };
  return { joined: true, stableId: String(self.ID), node: String(self.HostName || "") };
}

// ---- the desktop, end to end ----

const boxFile = root => path.join(root, "relay-device", "box.json");
/** The box this machine paired with as a device (core/relay/redeem.js writes it), or null. @param {string} root */
export function pairedBox(root) {
  try { return JSON.parse(fs.readFileSync(boxFile(root), "utf8")); } catch { return null; }
}
/** @param {string} root @param {any} patch */
function note(root, patch) {
  const b = pairedBox(root);
  if (!b) return;
  const tmp = `${boxFile(root)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...b, tailnet: { ...(b.tailnet || {}), ...patch, at: Date.now() } }), { mode: 0o600 });
  fs.renameSync(tmp, boxFile(root));
}

/**
 * After a desktop pairs with a box over the relay (ADR 0046 section 3): ask the box for a tagged
 * key over the paired channel, join the tailnet with it, then bind the new node by presenting the
 * bind code to the box over the tailnet itself. Any step that cannot happen leaves the device on
 * the relay, which already works; the next start tries again. Never throws.
 * @param {{ root: string, hostname?: string, fetch?: typeof fetch, connect?: typeof connect, log?: (m: string) => void, wait?: (ms: number) => Promise<void> }} o
 * @returns {Promise<{ state: string, why?: string, install?: string, node?: string }>}
 */
export async function desktopJoin(o) {
  const log = o.log || (() => {});
  const b = pairedBox(o.root);
  if (!b || !b.relay || !b.route || !b.box) return { state: "unpaired" };
  if (b.tailnet && b.tailnet.state === "joined") return { state: "joined", node: b.tailnet.node };
  const done = (state, extra = {}) => { note(o.root, { state, ...extra }); return { state, ...extra }; };
  const ready = await canJoin();
  if (!ready.ready) return done(ready.why === "not_installed" ? "relay_only" : ready.why === "already_on_a_tailnet" ? "own_tailnet" : "relay_only", { why: ready.why, ...(ready.install ? { install: ready.install } : {}) });

  let grant = null;
  const conn = (o.connect || connect)({ relay: b.relay, route: b.route, box: b.box, crypto: nodeCrypto(), keyStore: fileKeyStore(path.join(o.root, "relay-device", "key.json")) });
  try {
    const res = await conn.fetch(JOIN_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const body = /** @type {any} */ (await res.json());
    if (!res.ok || !body || !body.data) return done("relay_only", { why: (body && body.error && body.error.code) || `the box answered ${res.status}` });
    grant = body.data;
  } catch (e) { return done("relay_only", { why: `could not ask the box: ${/** @type {Error} */ (e).message}` }); }
  finally { try { conn.close(); } catch {} }

  const joined = await joinWithKey(grant.authKey, { hostname: o.hostname });
  grant.authKey = "";
  if (!joined.joined) { log(`relay: tailnet join failed: ${joined.why}`); return done("relay_only", { why: joined.why }); }

  // The box binds whois's node id for this connection, never the one we just read ourselves.
  const f = o.fetch || globalThis.fetch;
  const wait = o.wait || (ms => new Promise(r => setTimeout(r, ms).unref()));
  let last = "";
  for (let i = 0; i < 5; i++) {
    try {
      const res = await f(`${String(grant.address).replace(/\/+$/, "")}/v1/tailnet/bind`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device: grant.device, code: grant.bindCode }) });
      if (res.ok) return done("joined", { node: joined.node, why: undefined });
      last = `the box answered ${res.status}`;
      if (res.status === 403) break;
    } catch (e) { last = /** @type {Error} */ (e).message; }
    await wait(2000 * (i + 1));
  }
  log(`relay: joined the tailnet but the box did not bind this node: ${last}`);
  return done("unbound", { why: last, node: joined.node });
}
