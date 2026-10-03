// @ts-check
// policy: the network half of the grant compiler (SPEC-wink-network 4.3 item 4, 5.2, 5.3; EC-7).
//
// A pure function from the device table and the grants to a Headscale policy. Deny by default:
// Headscale refuses any flow no rule accepts, so the output names only what is allowed.
//
//   hub and spoke   a bound device reaches each hub on the hub's Vyre port, and nothing else;
//                   a hub reaches each bound compute node on the job port, and nothing else.
//   unbound         a node that is not bound to a live device row gets NO rule and no name (EC-7).
//   no role by tag  the role of a row is its `kind` column. A tag on a node, a node name, a user
//                   name or hostinfo is never read. Tags appear in the output only as `tagOwners`
//                   so that a pre-auth key can carry one; no rule mentions a tag.
//   no device pair  two devices never reach each other unless a grant names that exact pair
//                   and port (a feature names the pair, section 4.3 item 4).
//   no ssh          the policy has an empty ssh section.
//
// Rules name nodes by host alias, and every alias is a /32 address that comes from a row, so the
// access list is built from rows and never from anything a client can set. Same inputs, same bytes.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * @typedef {{ id: string, kind: "hub"|"device"|"compute", bound: boolean, ip?: string|null,
 *   nodeKey?: string, stableId?: string, tags?: string[] }} Row
 * @typedef {{ src: string, dst: string, port: number }} Grant
 */

const KINDS = new Set(["hub", "device", "compute"]);

/** @param {unknown} p */
function port(p) {
  const n = Number(p);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`policy: bad port ${String(p)}`);
  return n;
}

/** @param {string} ip */
function ip4(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || ""));
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some(x => x > 255)) return null;
  return ((o[0] * 256 + o[1]) * 256 + o[2]) * 256 + o[3];
}

/** @param {string} cidr */
function cidr4(cidr) {
  const [a, b] = String(cidr).split("/");
  const base = ip4(a);
  const bits = Number(b);
  if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const size = 2 ** (32 - bits);
  const start = Math.floor(base / size) * size;
  return { start, end: start + size - 1 };
}

/** The host alias for a row. Rows with the same alias are refused. @param {string} id */
export function aliasFor(id) {
  const s = String(id).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!s) throw new Error("policy: empty row id");
  return "n-" + s;
}

const cmp = (/** @type {string} */ a, /** @type {string} */ b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * @param {{ rows: Row[], grants?: Grant[], hubPort: number, jobPort: number, prefix?: string,
 *   tags?: string[], owner?: string }} input
 * @returns {{ policy: any, text: string, skipped: { id: string, reason: string }[] }}
 */
export function compilePolicy(input) {
  const hubPort = port(input.hubPort);
  const jobPort = port(input.jobPort);
  const range = input.prefix ? cidr4(input.prefix) : null;
  if (input.prefix && !range) throw new Error("policy: bad prefix");
  const owner = String(input.owner || "wink");
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(owner)) throw new Error("policy: bad owner");
  const tagNames = [...new Set(input.tags || [])].sort(cmp);
  for (const t of tagNames) if (!/^tag:[a-z0-9][a-z0-9-]*$/.test(t)) throw new Error(`policy: bad tag ${t}`);

  /** @type {{ id: string, reason: string }[]} */
  const skipped = [];
  /** @type {Map<string, { alias: string, kind: string, ip: string }>} */
  const live = new Map();
  const seenAlias = new Map();
  for (const r of input.rows || []) {
    if (!r || typeof r.id !== "string" || !KINDS.has(r.kind)) { skipped.push({ id: String(r && r.id), reason: "bad-row" }); continue; }
    const alias = aliasFor(r.id);
    if (seenAlias.has(alias)) throw new Error(`policy: rows ${seenAlias.get(alias)} and ${r.id} share an alias`);
    seenAlias.set(alias, r.id);
    // Unbound means no rule and no name: the node is simply not in the policy (EC-7).
    if (r.bound !== true) { skipped.push({ id: r.id, reason: "unbound" }); continue; }
    const n = r.ip ? ip4(r.ip) : null;
    if (n === null) { skipped.push({ id: r.id, reason: "no-address" }); continue; }
    if (range && (n < range.start || n > range.end)) { skipped.push({ id: r.id, reason: "outside-prefix" }); continue; }
    live.set(r.id, { alias, kind: r.kind, ip: /** @type {string} */ (r.ip) });
  }
  const of = (/** @type {string} */ kind) => [...live.entries()].filter(([, v]) => v.kind === kind).map(([, v]) => v.alias).sort(cmp);
  const hubs = of("hub"), devices = of("device"), computes = of("compute");

  /** @type {any[]} */
  const acls = [];
  for (const h of hubs) {
    if (devices.length) acls.push({ action: "accept", proto: "tcp", src: devices, dst: [`${h}:${hubPort}`] });
    if (computes.length) acls.push({ action: "accept", proto: "tcp", src: [h], dst: computes.map(c => `${c}:${jobPort}`) });
  }
  // Explicit pairs: both ends must be live; a grant never widens beyond its one port.
  const seenGrant = new Set();
  const extra = [];
  for (const g of input.grants || []) {
    const a = live.get(g.src), b = live.get(g.dst);
    const p = port(g.port);
    if (!a || !b || g.src === g.dst) { skipped.push({ id: `${g.src}>${g.dst}`, reason: "grant-endpoint" }); continue; }
    const k = `${a.alias}>${b.alias}:${p}`;
    if (seenGrant.has(k)) continue;
    seenGrant.add(k);
    extra.push({ action: "accept", proto: "tcp", src: [a.alias], dst: [`${b.alias}:${p}`] });
  }
  extra.sort((x, y) => cmp(x.src[0] + x.dst[0], y.src[0] + y.dst[0]));
  acls.push(...extra);

  /** @type {Record<string, string>} */
  const hosts = {};
  for (const alias of [...live.values()].map(v => v.alias).sort(cmp)) {
    hosts[alias] = `${[...live.values()].find(v => v.alias === alias)?.ip}/32`;
  }
  /** @type {Record<string, string[]>} */
  const tagOwners = {};
  for (const t of tagNames) tagOwners[t] = [`${owner}@`];

  const policy = { tagOwners, hosts, acls, ssh: [] };
  skipped.sort((x, y) => cmp(x.id + x.reason, y.id + y.reason));
  return { policy, text: JSON.stringify(policy, null, 2) + "\n", skipped };
}

/**
 * Write the policy file (atomic, 0600) and, if it changed, ask Headscale to re-read it. Headscale
 * in file mode reloads on SIGHUP (`headscale policy set` is refused in file mode).
 * @param {string} file
 * @param {number|null|undefined} hupPid the supervised Headscale's pid, or none to only write
 * @param {string} [text] the new policy; without it the file is only signalled
 * @param {{ kill?: (pid: number, sig: string) => void }} [io]
 * @returns {{ changed: boolean, signalled: boolean, sha256: string|null }}
 */
export function applyPolicy(file, hupPid, text, io = {}) {
  const kill = io.kill || ((pid, sig) => process.kill(pid, /** @type {any} */ (sig)));
  let changed = true;
  if (typeof text === "string") {
    JSON.parse(text); // a policy that is not valid JSON never replaces a working one
    let prev = null;
    try { prev = fs.readFileSync(file, "utf8"); } catch { /* first write */ }
    changed = prev !== text;
    if (changed) {
      const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(4).toString("hex")}`);
      fs.writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
      fs.renameSync(tmp, file);
    }
  }
  let signalled = false;
  if (changed && hupPid) { kill(hupPid, "SIGHUP"); signalled = true; }
  let sha256 = null;
  try { sha256 = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); } catch { /* none */ }
  return { changed, signalled, sha256 };
}
