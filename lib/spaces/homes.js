// @ts-check
// lib/spaces/homes.js: "Create a space" as an idempotent, resumable state machine, plus the server pairing
// states, the this-computer warning and the move-home plan. Pure library: the store, clock, randomness, key
// holder, names directory, members, records driver, pairing service, home host and the VPS driver are injected.
// Source: team/0.3/DESIGN-spaces-first.md sections 1b, 2 and "The install experience";
// team/0.2.5/DECISION-space-shape.md item 7 (one home plus compute machines).
//
// Steps, in order: validate, rootkey, claim, owner, home, unit, workspace.
// Every step is persisted before and after it runs, so resume(spaceId) continues from the last good step and never
// repeats a done one. Events carry step names and states, never a key, a code, a token or a secret. Every reason
// shown to a person is plain words written here (or by the VPS driver, which redacts); a raw error is never passed on.
//
// Contracts the injected parts must keep (see README-homes.md):
//   names.claimSpace is idempotent for the same name and rootPublic; keys.hold overwrites; homeHost.apply
//   replaces the unit's files as a whole and runs once per space unless it fails.

import { homeUnit, verifyUnit, VOLUME_ROLES, SPACE_ID_RE } from "./home-unit.js";
import * as realVps from "./vps.js";
import { INSTALL_COMMAND, PAIR_PROMPT, estimateMonthly } from "./vps.js";

export { INSTALL_COMMAND, PAIR_PROMPT };
export const STEPS = Object.freeze(["validate", "rootkey", "claim", "owner", "home", "unit", "workspace"]);
export const PAIRING_STATES = Object.freeze(["waiting_for_code", "matched", "home_ready", "timed_out", "locked"]);
export const PAIRING_DEFAULTS = Object.freeze({ maxTries: 5, ttlMs: 10 * 60 * 1000 });

export class HomesError extends Error {
  /** @param {string} code @param {string} plain */
  constructor(code, plain) { super(plain); this.name = "HomesError"; this.code = code; this.plain = plain; }
}
/** @param {string} code @param {string} plain @returns {never} */
const fail = (code, plain) => { throw new HomesError(code, plain); };

/**
 * @typedef {Object} HomesDeps
 * @property {{ get(key: string): Promise<any>, put(key: string, value: any): Promise<void>, delete?(key: string): Promise<void> }} store
 * @property {(type: string, payload: any) => void} [emit]
 * @property {{ now(): number }} clock
 * @property {(n: number) => Uint8Array} random
 * @property {{ generate(): Promise<{ publicKey: string, privateKey: string }>, hold(spaceId: string, privateKey: string): Promise<void>, discard?(spaceId: string): Promise<void> }} keys
 * @property {{ check(label: string): Promise<any>, claimSpace(a: { name: string, rootPublic: string, record: any }): Promise<any>, releaseSpace?(a: { name: string, spaceId: string }): Promise<any>, pointHome?(a: { name: string, spaceId: string, home: any }): Promise<any> }} names
 * @property {{ bootstrapOwner(personId: string, ctx?: any): Promise<any> }} members
 * @property {{ provisionWorkspace(a: { spaceId: string, name: string }): Promise<any>, deleteWorkspace?(a: { spaceId: string }): Promise<any> }} records
 * @property {{ startCode(spaceId: string, ctx?: any): Promise<{ code: string, expiresAt?: number }>, verifyCode(spaceId: string, code: string, ctx?: any): Promise<any> }} pairing
 * @property {{ apply(a: { spaceId: string, home: any, unit: { files: any[], manifest: any } }): Promise<any>, join?(a: { spaceId: string, joinId: string, role: string }): Promise<any> }} homeHost
 * @property {{ createDroplet: Function, waitActive: Function, destroy: Function }} [vps]
 * @property {any} [vpsDeps]  fetch, sleep and timers for the VPS driver
 * @property {{ maxTries?: number, ttlMs?: number }} [pairingOptions]
 */

const now = (/** @type {HomesDeps} */ d) => d.clock.now();
const emit = (/** @type {HomesDeps} */ d, /** @type {string} */ type, /** @type {any} */ payload) => { try { d.emit?.(type, payload); } catch { /* an event listener never breaks a step */ } };
const keyOf = (/** @type {string} */ id) => `space-create/${id}`;
const hex = (/** @type {HomesDeps} */ d, /** @type {number} */ n) => Buffer.from(d.random(n)).toString("hex");
const clone = (/** @type {any} */ v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const popts = (/** @type {HomesDeps} */ d) => ({ ...PAIRING_DEFAULTS, ...(d.pairingOptions ?? {}) });

// ---------- pairing states ----------

/**
 * Begin a pairing: the device shows the code, the person types it on the server.
 * @param {string} spaceId @param {HomesDeps} deps @param {any} [ctx]
 */
async function pairingBegin(spaceId, deps, ctx) {
  const t = now(deps), o = popts(deps);
  let s;
  try { s = await deps.pairing.startCode(spaceId, ctx); } catch { fail("pairing_unavailable", "Could not make a code to show you. Try again in a moment."); }
  if (!s || typeof s.code !== "string") fail("pairing_unavailable", "Could not make a code to show you. Try again in a moment.");
  return { state: "waiting_for_code", code: s.code, tries: 0, maxTries: o.maxTries, startedAt: t, expiresAt: s.expiresAt ?? t + o.ttlMs };
}

/**
 * Move a pairing one step on. Returns the new pairing and what happened. The two numbers must match.
 * @param {any} p @param {string} spaceId @param {string} code @param {HomesDeps} deps @param {any} [ctx]
 */
async function pairingSubmit(p, spaceId, code, deps, ctx) {
  if (!p || p.state !== "waiting_for_code") return { p, outcome: p?.state ?? "none" };
  if (now(deps) > p.expiresAt) return { p: { ...p, state: "timed_out" }, outcome: "timed_out" };
  const next = { ...p, tries: p.tries + 1 };
  const formatOk = typeof code === "string" && /^\d{4,8}$/.test(code.trim());
  let ok = false;
  if (formatOk) {
    try { const r = await deps.pairing.verifyCode(spaceId, code.trim(), ctx); ok = r === true || r?.ok === true; } catch { ok = false; }
  }
  if (ok) return { p: { ...next, state: "matched" }, outcome: "matched" };
  if (next.tries >= p.maxTries) return { p: { ...next, state: "locked" }, outcome: "locked" };
  return { p: next, outcome: "wrong_code" };
}

const pairingReason = (/** @type {string} */ state) => state === "timed_out"
  ? "The code ran out of time. Start again to get a new one."
  : "Too many wrong codes. Start again to get a new one.";

/** What the device shows while the server waits. */
const showFor = (/** @type {any} */ p) => ({ for: "code", installCommand: INSTALL_COMMAND, prompt: PAIR_PROMPT, code: p.code, expiresAt: p.expiresAt, triesLeft: p.maxTries - p.tries });

/**
 * "On a server you have": the one command, then the code step.
 * @param {{ spaceId: string }} plan @param {HomesDeps} deps
 */
export async function serverInstall(plan, deps) {
  const p = await pairingBegin(plan.spaceId, deps, { purpose: "home" });
  return { state: p.state, ...showFor(p), pairing: p };
}

// ---------- this computer ----------

/**
 * @param {{ id?: string, name?: string, alwaysOn?: boolean }} device
 */
export function assessThisComputer(device) {
  const name = device?.name ? String(device.name) : "this computer";
  const alwaysOn = device?.alwaysOn === true;
  return {
    device: { id: device?.id ?? null, name },
    alwaysOn,
    warning: `The space is unreachable while ${name} sleeps, is switched off or is offline. Nobody on the team can open it then, and its assistants and Flows stop.`,
    advice: alwaysOn ? `${name} is set to stay on, so this works while it stays plugged in and awake.` : `${name} is not set to stay on. A server keeps a space reachable day and night.`,
    moveToServerLater: "You can move the space to a server later in one action, because the space is one unit.",
    needsConfirmation: true,
  };
}

// ---------- move ----------

/**
 * One action, because a space is one unit. The plan and its checks are the deliverable; no data moves here.
 * @param {{ id: string, name?: string, home?: any, manifest?: { volumes: string[] } }} space
 * @param {{ kind: string, id?: string, host?: string, device?: any }} newHome
 */
export function planMoveHome(space, newHome) {
  if (!space || typeof space.id !== "string" || !SPACE_ID_RE.test(space.id)) fail("bad_space", "That space has no usable id.");
  if (!newHome || !["server", "vps", "this-computer"].includes(newHome.kind)) fail("bad_home", "Pick where the space will live: a server, a new server or this computer.");
  /** @param {any} a @param {any} b */
  const same = (a, b) => a && b && a.kind === b.kind && (a.id ?? a.host ?? a.device?.id ?? null) === (b.id ?? b.host ?? b.device?.id ?? null) && (a.id ?? a.host ?? a.device?.id) !== undefined;
  if (same(space.home, newHome)) fail("same_home", "The space already lives there.");
  const volumes = space.manifest?.volumes ?? VOLUME_ROLES.filter(r => r !== "headscale").map(r => `vyre-${space.id}-${r}`);
  const checks = {
    quiesce: ["No Flow or assistant is mid-write", "New writes are refused with a clear message", "The log's last entry is recorded"],
    snapshot: volumes.map(v => `Volume ${v} has a snapshot with its size and sha256 written down`),
    transfer: ["The snapshots travel encrypted to the new home", "Bytes received equal bytes sent for every volume"],
    verify: [...volumes.map(v => `The sha256 of ${v} on the new home equals the snapshot's`), "The log's last entry and its chain hash match", "The new unit passes verifyUnit and starts with the old secrets and keys volume", "Twenty answers a read of one record from every type"],
    switch: ["The name's sealed record is re-signed by the space's root key with owners present", "The directory resolves the name to the new home and the pinned key is unchanged", "A device re-enrolled from the record reaches the new home"],
    release: ["The old unit stops only after the new home has served for a grace period", "Snapshots stay on the old home for a few days and are then deleted with the person's confirmation", "If any check above fails, the old home resumes and nothing has switched"],
  };
  const steps = [
    { id: "quiesce", title: "Pause the space", detail: "Finish running work and refuse new writes so nothing changes during the copy.", checks: checks.quiesce },
    ...volumes.map(v => ({ id: `snapshot:${v}`, title: `Snapshot ${v}`, detail: "Take a consistent copy of this volume.", checks: [checks.snapshot[volumes.indexOf(v)]] })),
    { id: "transfer", title: "Copy to the new home", detail: "Send every snapshot, encrypted, to the new home.", checks: checks.transfer },
    { id: "verify", title: "Check the copy", detail: "Compare hashes and start the unit before anything points at it.", checks: checks.verify },
    { id: "switch", title: "Point the name at the new home", detail: "Re-sign the name's sealed record so the space's address leads to the new home.", checks: checks.switch },
    { id: "release", title: "Release the old home", detail: "Stop the old unit and keep its snapshots for a short grace period.", checks: checks.release },
  ];
  return { oneAction: true, requires: "owner", spaceId: space.id, from: space.home ?? null, to: newHome, volumes, steps, summary: `Move ${space.name ?? space.id} in one action: ${steps.length} ordered steps, nothing switches until every hash matches.` };
}

// ---------- the create flow ----------

const stepReasons = /** @type {Record<string, string>} */ ({
  validate: "The plan could not be checked.", rootkey: "Could not make or keep the space's key. Nothing was published.",
  claim: "Could not claim the name. Try again in a moment.", owner: "Could not add you as the owner yet. Try again in a moment.",
  home: "Could not set up the home yet. Try again in a moment.", unit: "Could not install the space's own services on its home. Try again in a moment.",
  workspace: "Could not make the space's records workspace. Try again in a moment.",
});
/** The only text a person sees for a failure: ours, or a driver's own plain words. Never a raw error. */
function reasonOf(/** @type {string} */ step, /** @type {any} */ e) {
  if (e instanceof HomesError || e?.name === "VpsError") return { reason: String(e.plain ?? e.message), code: /^[a-z0-9_.-]{1,40}$/.test(e.code ?? "") ? e.code : "failed" };
  return { reason: stepReasons[step] ?? "Something went wrong.", code: "failed" };
}

/** @param {any} rec */
function view(rec) {
  const first = STEPS.find(s => rec.steps[s]?.state !== "done") ?? null;
  const bad = STEPS.find(s => rec.steps[s]?.state === "failed");
  return {
    spaceId: rec.spaceId, status: rec.status, name: rec.name, domain: rec.out.claimed?.domain ?? null, step: first,
    steps: STEPS.map(s => ({ step: s, state: rec.steps[s]?.state ?? "pending", ...(rec.steps[s]?.reason ? { reason: rec.steps[s].reason } : {}) })),
    waiting: rec.status === "waiting" ? clone(rec.waiting) : null,
    failed: bad ? { step: bad, reason: rec.steps[bad].reason } : null,
    address: rec.out.address ?? null, workspaceId: rec.out.workspaceId ?? null,
    estimate: rec.out.estimate ?? null,
    cancel: rec.cancel ?? null,
  };
}

const persist = async (/** @type {HomesDeps} */ d, /** @type {any} */ rec) => { rec.updatedAt = now(d); await d.store.put(keyOf(rec.spaceId), clone(rec)); };
async function setStep(/** @type {HomesDeps} */ d, /** @type {any} */ rec, /** @type {string} */ step, /** @type {string} */ state, /** @type {{ reason?: string, code?: string }} */ extra = {}) {
  rec.steps[step] = { state, ...(extra.reason ? { reason: extra.reason } : {}) };
  await persist(d, rec);
  emit(d, "space.create.step", { spaceId: rec.spaceId, step, state, ...(extra.reason ? { reason: extra.reason } : {}), ...(extra.code ? { code: extra.code } : {}) });
}

/** @typedef {{ vpsToken?: string, name?: string, confirmThisComputer?: boolean }} Ctx */

const vpsApi = (/** @type {HomesDeps} */ d) => d.vps ?? realVps;

/** @type {Record<string, (rec: any, d: HomesDeps, ctx: Ctx) => Promise<void | { wait: any }>>} */
const EXEC = {
  async validate(rec, d, ctx) {
    const label = String(rec.name ?? "").trim().toLowerCase();
    if (!label) fail("bad_name", "Give the space a name.");
    let c;
    try { c = await d.names.check(label); } catch { fail("names_unavailable", "Could not check the name just now. Try again in a moment."); }
    if (c === false || c?.ok === false) fail(c?.reason === "taken" ? "name_taken" : "bad_name", typeof c?.message === "string" && c.message ? c.message : c?.reason === "taken" ? "That name is taken. Pick another." : "That name can't be used. Use letters, numbers and hyphens, starting with a letter.");
    rec.name = label;
    if (typeof rec.personId !== "string" || !rec.personId) fail("bad_plan", "Sign in with your Vyre name before creating a space.");
    const h = rec.home;
    if (!h || !["server", "vps", "this-computer"].includes(h.kind)) fail("bad_home", "Pick where the space will live: a server you have, a new server, or this computer.");
    if (h.kind === "vps") {
      if (h.provider !== "digitalocean") fail("bad_home", "Only DigitalOcean is offered for a new server for now.");
      try { rec.out.estimate = estimateMonthly(h.size, h.region); } catch (e) { fail("bad_home", /** @type {any} */ (e).message); }
      if (!ctx.vpsToken) fail("no_token", "Paste your DigitalOcean token to create the server.");
    }
    if (h.kind === "this-computer") {
      if (!h.device || typeof h.device !== "object") fail("bad_home", "Say which computer this is.");
      rec.out.assessment = assessThisComputer(h.device);
      if (!(h.confirmed === true || ctx.confirmThisComputer === true)) return { wait: { for: "confirm", assessment: rec.out.assessment } };
      h.confirmed = true;
    }
  },

  async rootkey(rec, d) {
    if (rec.out.rootPublic) return;
    let pair;
    try { pair = await d.keys.generate(); } catch { fail("key_failed", "Could not make the space's key. Nothing was published."); }
    if (!pair?.publicKey || !pair?.privateKey) fail("key_failed", "Could not make the space's key. Nothing was published.");
    try { await d.keys.hold(rec.spaceId, pair.privateKey); } catch { fail("key_failed", "Could not keep the space's key safe on this device. Nothing was published."); }
    rec.out.rootPublic = pair.publicKey;
    pair = undefined;
  },

  async claim(rec, d) {
    if (rec.out.claimed) return;
    let r;
    try { r = await d.names.claimSpace({ name: rec.name, rootPublic: rec.out.rootPublic, record: { kind: "space", spaceId: rec.spaceId, displayName: rec.displayName ?? rec.name } }); } catch (e) { r = { ok: false, code: /** @type {any} */ (e)?.code, message: undefined }; }
    if (r?.ok === false || r === false) {
      if (r?.code === "taken" || r?.reason === "taken") fail("name_taken", "That name was just taken. Pick another and continue.");
      fail("claim_failed", typeof r?.message === "string" && r.message ? r.message : "Could not claim the name. Try again in a moment.");
    }
    rec.out.claimed = { name: rec.name, domain: `${rec.name}.vyre.run` };
  },

  async owner(rec, d) {
    if (rec.out.owner) return;
    try { await d.members.bootstrapOwner(rec.personId, { spaceId: rec.spaceId }); } catch { fail("owner_failed", "Could not add you as the space's owner yet. Try again in a moment."); }
    rec.out.owner = true;
  },

  async home(rec, d, ctx) {
    const h = rec.home;
    if (h.kind === "this-computer") {
      rec.out.home = { kind: "this-computer", device: h.device };
      return;
    }
    if (h.kind === "vps" && !rec.out.droplet) {
      if (!ctx.vpsToken) fail("no_token", "Paste your DigitalOcean token again to continue.");
      const made = await vpsApi(d).createDroplet({ token: ctx.vpsToken, spaceId: rec.spaceId, name: `vyre-${rec.name}`, region: h.region, size: h.size }, d.vpsDeps ?? {});
      rec.out.droplet = { dropletId: made.dropletId, firewallId: made.firewallId };
      await persist(d, rec); // the droplet exists now: never lose track of it
    }
    if (h.kind === "vps" && !rec.out.address) {
      if (!ctx.vpsToken) fail("no_token", "Paste your DigitalOcean token again to continue.");
      const up = await vpsApi(d).waitActive(ctx.vpsToken, rec.out.droplet.dropletId, d.vpsDeps ?? {});
      rec.out.address = up.address;
    }
    // server or vps: the code step. The server is not the home until the numbers match.
    let p = rec.out.pairing;
    if (!p) {
      p = rec.out.pairing = await pairingBegin(rec.spaceId, d, { purpose: "home" });
      emit(d, "space.pairing.state", { spaceId: rec.spaceId, state: p.state, triesLeft: p.maxTries - p.tries });
    }
    if (p.state === "waiting_for_code" && now(d) > p.expiresAt) { p.state = "timed_out"; }
    if (p.state === "timed_out" || p.state === "locked") fail(`pairing_${p.state}`, pairingReason(p.state));
    if (p.state === "waiting_for_code") return { wait: showFor(p) };
    // matched
    p.state = "home_ready";
    rec.out.home = { kind: h.kind, ...(rec.out.address ? { address: rec.out.address } : {}), ...(rec.out.droplet ? { provider: "digitalocean" } : {}) };
    emit(d, "space.pairing.state", { spaceId: rec.spaceId, state: "home_ready", triesLeft: p.maxTries - p.tries });
  },

  async unit(rec, d) {
    if (rec.out.unit) return;
    if (!rec.out.home || (rec.out.pairing && rec.out.pairing.state !== "home_ready")) fail("no_home", "The home is not ready yet.");
    const unit = homeUnit({ id: rec.spaceId, name: rec.name }, { random: d.random, headscale: rec.headscale === true });
    const v = verifyUnit(unit.compose);
    if (!v.ok) fail("unit_unsound", "The space's services failed their safety check, so nothing was installed.");
    try { await d.homeHost.apply({ spaceId: rec.spaceId, home: clone(rec.out.home), unit: { files: unit.files, manifest: unit.manifest } }); } catch { fail("unit_failed", stepReasons.unit); }
    rec.out.unit = { manifest: unit.manifest };
    await persist(d, rec);
    if (d.names.pointHome) {
      try { await d.names.pointHome({ name: rec.name, spaceId: rec.spaceId, home: clone(rec.out.home) }); } catch { fail("unit_failed", "The services are installed but the name could not be pointed at the home yet. Try again in a moment."); }
    }
  },

  async workspace(rec, d) {
    if (rec.out.workspaceId) return;
    let r;
    try { r = await d.records.provisionWorkspace({ spaceId: rec.spaceId, name: rec.name }); } catch { fail("workspace_failed", stepReasons.workspace); }
    rec.out.workspaceId = r?.workspaceId ?? r?.id ?? "workspace";
  },
};

/** @param {any} rec @param {HomesDeps} d @param {Ctx} ctx */
async function run(rec, d, ctx) {
  for (const step of STEPS) {
    if (rec.steps[step]?.state === "done") continue;
    rec.status = "running"; rec.waiting = null;
    await setStep(d, rec, step, "running");
    try {
      const r = await EXEC[step](rec, d, ctx);
      if (r && "wait" in r) {
        rec.status = "waiting"; rec.waiting = r.wait;
        await setStep(d, rec, step, "waiting");
        return view(rec);
      }
      await setStep(d, rec, step, "done");
    } catch (e) {
      const { reason, code } = reasonOf(step, e);
      rec.status = "failed"; rec.waiting = null;
      await setStep(d, rec, step, "failed", { reason, code });
      return view(rec);
    }
  }
  rec.status = "done"; rec.waiting = null;
  await persist(d, rec);
  emit(d, "space.create.done", { spaceId: rec.spaceId });
  return view(rec);
}

const load = async (/** @type {HomesDeps} */ d, /** @type {string} */ id) => {
  if (typeof id !== "string" || !SPACE_ID_RE.test(id)) fail("bad_space", "That space id is not valid.");
  const rec = await d.store.get(keyOf(id));
  if (!rec) fail("unknown_space", "No space is being created with that id.");
  return rec;
};

/** Strip secrets from the plan before it is stored. The token lives only in the caller's hands. */
function sanitizePlan(/** @type {any} */ plan) {
  const h = { ...(plan.home ?? {}) };
  delete h.token;
  return h;
}

/**
 * Create a space. Idempotent: the same spaceId resumes the stored attempt. Pass `spaceId` to be able to find it again.
 * @param {{ spaceId?: string, name: string, displayName?: string, personId: string, home: any, headscale?: boolean }} plan
 * @param {HomesDeps} deps @param {Ctx} [ctx]
 */
export async function createSpace(plan, deps, ctx = {}) {
  const spaceId = plan?.spaceId ?? `spc_${hex(deps, 6)}`;
  if (!SPACE_ID_RE.test(spaceId)) fail("bad_space", "A space id looks like spc_ followed by lowercase letters or digits.");
  const existing = await deps.store.get(keyOf(spaceId));
  if (existing) return resume(spaceId, deps, ctx);
  const t = now(deps);
  const token = plan?.home?.token;
  const rec = { spaceId, status: "running", name: plan?.name, displayName: plan?.displayName, personId: plan?.personId, home: sanitizePlan(plan ?? {}), headscale: plan?.headscale === true, steps: {}, out: {}, waiting: null, createdAt: t, updatedAt: t };
  return run(rec, deps, { ...ctx, vpsToken: ctx.vpsToken ?? token, name: undefined });
}

/**
 * Continue from the last good step. A done step is never repeated. Failed or waiting steps run again.
 * `ctx.name` replaces the name when it was never claimed; `ctx.vpsToken` supplies the token again.
 * @param {string} spaceId @param {HomesDeps} deps @param {Ctx} [ctx]
 */
export async function resume(spaceId, deps, ctx = {}) {
  const rec = await load(deps, spaceId);
  if (rec.status === "done" || rec.status === "cancelled") return view(rec);
  if (ctx.name !== undefined) {
    if (rec.out.claimed) fail("name_claimed", "The name is already claimed, so it can't change now.");
    rec.name = ctx.name;
    rec.steps.validate = { state: "pending" };
  }
  const h = rec.steps.home;
  if (h?.state === "failed" && ["timed_out", "locked"].includes(rec.out.pairing?.state)) rec.out.pairing = undefined; // a new code
  if (rec.out.pairing?.state === "timed_out" || rec.out.pairing?.state === "locked") rec.out.pairing = undefined;
  if (rec.out.pairing?.state === "waiting_for_code" && now(deps) > rec.out.pairing.expiresAt) rec.out.pairing = undefined;
  if (rec.steps.validate?.state === "done" && ctx.confirmThisComputer && rec.home?.kind === "this-computer") rec.home.confirmed = true;
  for (const s of STEPS) if (rec.steps[s]?.state === "failed") rec.steps[s] = { state: "pending" };
  if (rec.home?.kind === "this-computer" && ctx.confirmThisComputer) { rec.home.confirmed = true; if (rec.steps.validate?.state === "waiting") rec.steps.validate = { state: "pending" }; }
  return run(rec, deps, ctx);
}

/**
 * The person typed the code on the server. The two numbers must match.
 * @param {string} spaceId @param {string} code @param {HomesDeps} deps @param {Ctx} [ctx]
 */
export async function submitCode(spaceId, code, deps, ctx = {}) {
  const rec = await load(deps, spaceId);
  const p = rec.out.pairing;
  if (!p || p.state !== "waiting_for_code" || rec.status === "cancelled") fail("not_waiting", "This space is not waiting for a code.");
  const { p: next, outcome } = await pairingSubmit(p, spaceId, code, deps, { purpose: "home" });
  rec.out.pairing = next;
  emit(deps, "space.pairing.state", { spaceId, state: next.state, triesLeft: Math.max(0, next.maxTries - next.tries) });
  if (outcome === "matched") { rec.status = "running"; return { pairing: "matched", ...(await run(rec, deps, ctx)) }; }
  if (outcome === "timed_out" || outcome === "locked") {
    rec.status = "failed"; rec.waiting = null;
    await setStep(deps, rec, "home", "failed", { reason: pairingReason(outcome), code: `pairing_${outcome}` });
    return { pairing: outcome, ...view(rec) };
  }
  rec.waiting = showFor(next);
  await persist(deps, rec);
  return { pairing: "wrong_code", ...view(rec), message: `That code does not match. ${next.maxTries - next.tries} tries left.` };
}

/** @param {string} spaceId @param {HomesDeps} deps */
export async function status(spaceId, deps) { return view(await load(deps, spaceId)); }

/**
 * Roll back what can be rolled back, and say what could not be.
 * @param {string} spaceId @param {HomesDeps} deps @param {Ctx} [ctx]
 */
export async function cancel(spaceId, deps, ctx = {}) {
  const rec = await load(deps, spaceId);
  /** @type {string[]} */ const rolledBack = [];
  /** @type {{ what: string, why: string }[]} */ const couldNot = [];
  if (rec.status === "cancelled") return { cancelled: true, rolledBack: rec.cancel?.rolledBack ?? [], couldNot: rec.cancel?.couldNot ?? [] };
  if (rec.status === "done") {
    return { cancelled: false, rolledBack, couldNot: [{ what: "the space", why: "It is finished and its name is public. Remove it from the space's settings instead." }] };
  }
  const done = (/** @type {string} */ s) => rec.steps[s]?.state === "done";
  if (rec.out.workspaceId) {
    if (deps.records.deleteWorkspace) { try { await deps.records.deleteWorkspace({ spaceId }); rolledBack.push("the records workspace"); } catch { couldNot.push({ what: "the records workspace", why: "It could not be removed. Remove it from the records admin." }); } }
    else couldNot.push({ what: "the records workspace", why: "It stays on the home until the space is removed." });
  }
  if (rec.out.unit) couldNot.push({ what: "the services on the home", why: "They were installed on the home. Remove the space's folder there to clear them." });
  if (rec.out.droplet) {
    if (!ctx.vpsToken) couldNot.push({ what: "the new server", why: "Paste your DigitalOcean token to remove it, or delete it in your DigitalOcean account so it stops costing money." });
    else {
      try { await vpsApi(deps).destroy(ctx.vpsToken, rec.out.droplet, deps.vpsDeps ?? {}); rolledBack.push("the new server"); rec.out.droplet = undefined; }
      catch (e) { couldNot.push({ what: "the new server", why: e?.name === "VpsError" ? String(e.message) : "It could not be removed. Delete it in your DigitalOcean account so it stops costing money." }); }
    }
  } else if (rec.home?.kind === "server" && rec.out.pairing) {
    couldNot.push({ what: "Vyre on your server", why: "It stays installed there. Run the uninstall command on the server to clear it." });
  }
  if (rec.out.claimed) {
    if (deps.names.releaseSpace) { try { await deps.names.releaseSpace({ name: rec.out.claimed.name, spaceId }); rolledBack.push("the name"); rec.out.claimed = undefined; } catch { couldNot.push({ what: "the name", why: "It could not be released just now. It will stay yours until you release it." }); } }
    else couldNot.push({ what: "the name", why: "It stays yours until you release it." });
  }
  if (done("rootkey") || rec.out.rootPublic) {
    if (deps.keys.discard) { try { await deps.keys.discard(spaceId); rolledBack.push("the space's key"); } catch { couldNot.push({ what: "the space's key", why: "It stays on this device. Remove it from the device's key list." }); } }
    else couldNot.push({ what: "the space's key", why: "It stays on this device. Remove it from the device's key list." });
  }
  rec.status = "cancelled"; rec.waiting = null; rec.cancel = { rolledBack, couldNot };
  await persist(deps, rec);
  emit(deps, "space.create.cancelled", { spaceId, rolledBack, couldNot: couldNot.map(c => c.what) });
  return { cancelled: true, rolledBack, couldNot };
}

// ---------- add a server to an existing space ----------

/**
 * One command, then the code from your device. The server joins as compute, or as the new home when `moveHome` is set.
 * @param {{ spaceId: string, moveHome?: boolean, space?: any, newHome?: any }} input @param {HomesDeps} deps
 */
export async function addServer(input, deps) {
  if (!SPACE_ID_RE.test(input?.spaceId ?? "")) fail("bad_space", "That space id is not valid.");
  const joinId = `join_${hex(deps, 4)}`;
  const role = input.moveHome ? "home" : "compute";
  const p = await pairingBegin(input.spaceId, deps, { purpose: "add-server", joinId, role });
  const rec = { joinId, spaceId: input.spaceId, role, pairing: p, space: input.space ?? null, newHome: input.newHome ?? null, state: "waiting_for_code", createdAt: now(deps) };
  await deps.store.put(`space-join/${input.spaceId}/${joinId}`, clone(rec));
  return { joinId, role, state: p.state, ...showFor(p) };
}

/**
 * @param {string} spaceId @param {string} joinId @param {string} code @param {HomesDeps} deps
 */
export async function submitServerCode(spaceId, joinId, code, deps) {
  const k = `space-join/${spaceId}/${joinId}`;
  const rec = await deps.store.get(k);
  if (!rec) fail("unknown_join", "No server is waiting to join with that id.");
  if (rec.pairing.state !== "waiting_for_code") fail("not_waiting", "This server is not waiting for a code.");
  const { p, outcome } = await pairingSubmit(rec.pairing, spaceId, code, deps, { purpose: "add-server", joinId, role: rec.role });
  rec.pairing = p;
  emit(deps, "space.pairing.state", { spaceId, joinId, state: p.state, triesLeft: Math.max(0, p.maxTries - p.tries) });
  if (outcome === "matched") {
    try { await deps.homeHost.join?.({ spaceId, joinId, role: rec.role }); } catch { rec.pairing = { ...p, state: "waiting_for_code" }; await deps.store.put(k, clone(rec)); fail("join_failed", "The codes matched but the server could not join yet. Type the code again in a moment."); }
    rec.pairing.state = "home_ready"; rec.state = "joined";
    await deps.store.put(k, clone(rec));
    const plan = rec.role === "home" && rec.space && rec.newHome ? planMoveHome(rec.space, rec.newHome) : null;
    return { state: "joined", role: rec.role, ...(plan ? { movePlan: plan } : {}) };
  }
  await deps.store.put(k, clone(rec));
  if (outcome === "timed_out") return { state: "timed_out", message: pairingReason("timed_out") };
  if (outcome === "locked") return { state: "locked", message: pairingReason("locked") };
  return { state: "wrong_code", triesLeft: p.maxTries - p.tries, message: `That code does not match. ${p.maxTries - p.tries} tries left.` };
}

/** A bound set of the flow's functions for one set of deps. */
export function createSpaceFlow(/** @type {HomesDeps} */ deps) {
  return {
    createSpace: (/** @type {any} */ plan, /** @type {Ctx} */ ctx) => createSpace(plan, deps, ctx),
    resume: (/** @type {string} */ id, /** @type {Ctx} */ ctx) => resume(id, deps, ctx),
    cancel: (/** @type {string} */ id, /** @type {Ctx} */ ctx) => cancel(id, deps, ctx),
    status: (/** @type {string} */ id) => status(id, deps),
    submitCode: (/** @type {string} */ id, /** @type {string} */ code, /** @type {Ctx} */ ctx) => submitCode(id, code, deps, ctx),
    addServer: (/** @type {any} */ input) => addServer(input, deps),
    submitServerCode: (/** @type {string} */ id, /** @type {string} */ joinId, /** @type {string} */ code) => submitServerCode(id, joinId, code, deps),
    assessThisComputer, planMoveHome,
  };
}
