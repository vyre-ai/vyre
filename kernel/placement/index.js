// @ts-check
// Node placement by descriptor records (SPEC-core-contract section 11). One scheduler over the nodes' records; the runner asks it and keeps no placement logic of its own.
//
// A node is a machine that provides capabilities. Its descriptor is a record in its owner's Space (capabilities, resources, residency tags, posture, a lend policy), signed by the
// node's own key. The live state (online, on power, load) is not part of the descriptor: it changes by the second and is read from the machine, so it travels beside the record.
//
// Placement filters, scores, then places or refuses with a plain reason:
//   filter  two-way consent (the Space's policy and grant, the node owner's lend policy and grant), capability and resource fit, residency, posture, being online and awake, the lend
//           policy's limits (on power, CPU and memory ceilings). A node that fails says why in words a person can act on.
//   score   the node the requester sits at (locality), the node the workload prefers (the one holding the project's files), then lower load, more free memory, more uptime.
//   result  `workload.placed` with the node and every reason a node was passed over, or `workload.refused` with a code and the same reasons. The event goes out through `emit`.
// Pure: facts in, answer out. Nothing here grants anything; a placement is a decision, and the grants (node.run, node.host) are what let the work run.
import { createPublicKey, createPrivateKey, sign as edSign, verify as edVerify, generateKeyPairSync } from "node:crypto";
import { canonical } from "../core/canonical.js";

/** The capability names a descriptor may offer. */
export const CAPABILITIES = Object.freeze(["compute", "storage", "browser", "gpu", "ingress", "always-on", "client"]);

/** The lend policy's defaults: the device page's limits (DESIGN-local-runner). */
export const DEFAULT_LEND = Object.freeze({ onlyOnPower: true, onlyAwake: true, cpuMaxPct: 70, memMaxPct: 80 });

/** The record type a descriptor is stored as, for a kit or a view that lists nodes. */
export const NODE_TYPE = Object.freeze({
  name: "node", label: "Node", icon: "IconServer",
  fields: [
    { name: "name", kind: "text", label: "Name", required: true },
    { name: "kind", kind: "choice", label: "Kind", options: ["device", "server"], required: true },
    { name: "capabilities", kind: "text", label: "Capabilities" },
    { name: "resources", kind: "text", label: "Resources" },
    { name: "residency", kind: "text", label: "Residency tags" },
    { name: "posture", kind: "text", label: "Posture" },
    { name: "lend", kind: "text", label: "Lend policy" },
    { name: "key", kind: "text", label: "Node key" },
    { name: "sig", kind: "text", label: "Signature" },
  ],
});

const bad = (/** @type {string} */ m) => Object.assign(new Error(m), { code: "bad_input" });
const num = (/** @type {any} */ v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const strs = (/** @type {any} */ v) => Array.isArray(v) && v.every(x => typeof x === "string" && x);

/**
 * The shape of a descriptor, and nothing else. Returns it normalised.
 * @param {any} d
 */
export function checkDescriptor(d) {
  if (!d || typeof d !== "object" || Array.isArray(d)) throw bad("a node descriptor is an object");
  if (typeof d.id !== "string" || !d.id) throw bad("a node has an id");
  if (typeof d.name !== "string" || !d.name.trim()) throw bad("a node has a name");
  if (d.kind !== "device" && d.kind !== "server") throw bad("a node is a device or a server");
  if (!strs(d.capabilities || []) || (d.capabilities || []).some((/** @type {string} */ c) => !CAPABILITIES.includes(c))) throw bad(`capabilities are among ${CAPABILITIES.join(", ")}`);
  const r = d.resources || {};
  for (const k of ["cpus", "memMb", "diskMb"]) if (r[k] !== undefined && !num(r[k])) throw bad(`resources.${k} is a number`);
  if (!strs(d.residency || [])) throw bad("residency tags are words");
  const p = d.posture || {};
  if (p.diskEncrypted !== undefined && typeof p.diskEncrypted !== "boolean") throw bad("posture.diskEncrypted is true or false");
  const l = d.lend || {};
  if (l.spaces !== undefined && !strs(l.spaces)) throw bad("lend.spaces lists Spaces");
  for (const k of ["cpuMaxPct", "memMaxPct"]) if (l[k] !== undefined && !(num(l[k]) && l[k] <= 100)) throw bad(`lend.${k} is a percentage`);
  if (typeof d.key !== "string" || !d.key) throw bad("a node carries its public key");
  return { ...d, capabilities: [...new Set(d.capabilities || [])].sort(), residency: [...new Set(d.residency || [])].sort(), resources: r, posture: p, lend: l };
}

/** A node key pair: the public half goes in the descriptor, the private half never leaves the node. */
export function newNodeKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { key: publicKey.export({ type: "spki", format: "der" }).toString("base64url"), secret: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url") };
}

const body = (/** @type {any} */ d) => { const { sig: _s, ...rest } = d; return Buffer.from(canonical(rest)); };

/** Sign a descriptor with the node's key. @param {any} d @param {string} secret */
export function signDescriptor(d, secret) {
  const c = checkDescriptor(d);
  const k = createPrivateKey({ key: Buffer.from(secret, "base64url"), format: "der", type: "pkcs8" });
  return { ...c, sig: edSign(null, body(c), k).toString("base64url") };
}

/** Is the descriptor intact and signed by the key it carries? @param {any} d */
export function verifyDescriptor(d) {
  try {
    const c = checkDescriptor(d);
    if (typeof d.sig !== "string") return false;
    return edVerify(null, body(c), createPublicKey({ key: Buffer.from(c.key, "base64url"), format: "der", type: "spki" }), Buffer.from(d.sig, "base64url"));
  } catch { return false; }
}

/**
 * @typedef {{ online?: boolean, awake?: boolean, onPower?: boolean, cpuPct?: number, memPct?: number, freeMemMb?: number, uptimeS?: number, why?: string }} NodeStatus
 * @typedef {{ spaceAllows: boolean, nodeHosts: boolean }} Consent
 *   spaceAllows: the Space's policy and its `node.run` grant name this node. nodeHosts: the node owner's `node.host` grant names this Space.
 * @typedef {{ descriptor: any, status?: NodeStatus, consent: Consent, full?: boolean, notReady?: string }} NodeFact
 *   full: the node has no room for another workload (a slot count the node module keeps). notReady: a reason the node cannot start work yet (a sandbox or workspace that is missing).
 * @typedef {{ capabilities?: string[], cpus?: number, memMb?: number, residency?: string[], needsEncryptedDisk?: boolean }} Requires
 * @typedef {{ id?: string, requires?: Requires, prefers?: { node?: string }, at?: string, pinnedTo?: string, sealedOk?: boolean }} Workload
 *   at: the node the requester sits at (their own computer). pinnedTo: a node id, or "server": the work runs there and nowhere else.
 */

/**
 * Why this node cannot take the workload now, as a code and plain words, or null when it can.
 * @param {NodeFact} n @param {Workload} w @param {{ space: string, memberCompute?: boolean, residency?: string[] }} policy
 * @returns {{ code: string, reason: string } | null}
 */
export function nodeBlock(n, w, policy) {
  const d = n.descriptor, st = n.status || {}, req = w.requires || {};
  const lend = { ...DEFAULT_LEND, ...(d.lend || {}) };
  const device = d.kind === "device";
  // Two-way consent: neither side's yes implies the other.
  if (!n.consent.spaceAllows) return { code: "space_policy", reason: device ? "this space has not allowed members to run its work on their own computers" : "this space does not allow work on that node" };
  if (device && policy.memberCompute === false) return { code: "space_policy", reason: "this space has not allowed members to run its work on their own computers" };
  if (!n.consent.nodeHosts) return { code: "lend_policy", reason: device ? "this computer is not set to run this space's work" : "that node is not set to host this space" };
  if (Array.isArray(d.lend?.spaces) && !d.lend.spaces.includes(policy.space)) return { code: "lend_policy", reason: device ? "this computer is not set to run this space's work" : "that node is not set to host this space" };
  if (n.notReady) return { code: "not_ready", reason: n.notReady };
  if (st.online === false) return { code: "offline", reason: st.why || (device ? "this computer is not reachable" : "the space's server is not reachable") };
  const caps = req.capabilities || ["compute"];
  const missing = caps.filter(c => !(d.capabilities || []).includes(c));
  if (missing.length) return { code: "capability", reason: `it does not offer ${missing.join(", ")}` };
  const res = d.resources || {};
  if (req.cpus !== undefined && res.cpus !== undefined && res.cpus < req.cpus) return { code: "resources", reason: `it has ${res.cpus} CPUs and the work needs ${req.cpus}` };
  if (req.memMb !== undefined && res.memMb !== undefined && res.memMb < req.memMb) return { code: "resources", reason: `it has ${res.memMb} MB of memory and the work needs ${req.memMb}` };
  if (req.memMb !== undefined && st.freeMemMb !== undefined && st.freeMemMb < req.memMb) return { code: "resources", reason: `it has ${Math.round(st.freeMemMb)} MB of memory free and the work needs ${req.memMb}` };
  const want = [...(req.residency || []), ...(policy.residency || [])];
  const lacks = want.filter(t => !(d.residency || []).includes(t));
  if (lacks.length) return { code: "residency", reason: `it is not tagged ${lacks.join(", ")}, which the data needs` };
  if ((req.needsEncryptedDisk || device) && d.posture?.diskEncrypted === false) return { code: "posture", reason: "its disk is not encrypted" };
  if (device) {
    if (lend.onlyAwake && st.awake === false) return { code: "asleep", reason: "this computer is asleep" };
    if (lend.onlyOnPower && st.onPower === false) return { code: "battery", reason: "this computer is on battery and is set to run work only when plugged in" };
    if ((st.cpuPct ?? 0) > lend.cpuMaxPct) return { code: "busy", reason: `this computer is busy (${Math.round(st.cpuPct ?? 0)}% CPU, your limit is ${lend.cpuMaxPct}%)` };
    if ((st.memPct ?? 0) > lend.memMaxPct) return { code: "memory", reason: `this computer is short of memory (${Math.round(st.memPct ?? 0)}% used, your limit is ${lend.memMaxPct}%)` };
  }
  if (n.full) return { code: "full", reason: device ? "this computer is full" : "the space's server is full" };
  return null;
}

/** Higher is better. Locality first, the preferred node next, then spare capacity and uptime. */
function score(/** @type {NodeFact} */ n, /** @type {Workload} */ w) {
  const st = n.status || {};
  return (w.at && w.at === n.descriptor.id ? 1000 : 0)
    + (w.prefers?.node && w.prefers.node === n.descriptor.id ? 500 : 0)
    + (100 - Math.min(100, st.cpuPct ?? 0)) + (100 - Math.min(100, st.memPct ?? 0))
    + Math.min(50, (st.uptimeS ?? 0) / 3600);
}

/**
 * Place a workload. Returns `{ placed, node, reasons, reason }`; `emit` receives the `workload.placed` or `workload.refused` event body.
 * Every node's descriptor must verify; one whose signature fails is passed over (a record anyone could have edited decides nothing).
 * @param {{ space: string, workload: Workload, nodes: NodeFact[], policy?: { memberCompute?: boolean, residency?: string[] }, emit?: (type: string, data: any) => void, requireSigned?: boolean }} o
 */
export function placeWorkload(o) {
  const w = o.workload || {}, policy = { space: o.space, ...(o.policy || {}) };
  /** @type {{ node: string, code: string, reason: string }[]} */ const reasons = [];
  /** @type {NodeFact[]} */ const ok = [];
  for (const n of o.nodes) {
    const id = n.descriptor?.id;
    if (o.requireSigned !== false && !verifyDescriptor(n.descriptor)) { reasons.push({ node: id, code: "unsigned", reason: "its record is not signed by its own key" }); continue; }
    if (w.pinnedTo && w.pinnedTo !== id && !(w.pinnedTo === "server" && n.descriptor.kind === "server")) { reasons.push({ node: id, code: "pinned", reason: w.pinnedTo === "server" ? "this session is pinned to the server" : "this session is pinned to another node" }); continue; }
    const b = nodeBlock(n, w, policy);
    if (b) reasons.push({ node: id, ...b }); else ok.push(n);
  }
  const mem = reasons.length ? reasons : [];
  if (ok.length) {
    const best = ok.map(n => ({ n, s: score(n, w) })).sort((a, b) => b.s - a.s || (a.n.descriptor.id < b.n.descriptor.id ? -1 : 1))[0];
    const out = { placed: true, node: best.n.descriptor.id, kind: best.n.descriptor.kind, score: best.s, reasons: mem };
    o.emit?.("workload.placed", { workload: w.id ?? null, node: out.node, score: out.score, passed_over: mem });
    return out;
  }
  const code = mem.length ? mem[0].code : "no_nodes";
  const out = { placed: false, node: null, code, reasons: mem };
  o.emit?.("workload.refused", { workload: w.id ?? null, code, reasons: mem });
  return out;
}
