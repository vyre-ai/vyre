// @ts-check
// identity/signins: the sign-ins on a new device that wait on the person (the Needs you card, core/approvals/items.js). The sign-in service (kernel/identity/space-login.js) keeps each live session with the
// device id, its label and when; this module adds what the person says about them. Three tools, all for the owner's own username, which is read from this home's master record and never from an input:
//   identity.signins.pending   modules only (approvals reads it): the devices that rang the new-device notice, still signed in, that the person has not vouched for.
//   identity.signin.revoke     the person's own act ("Not me, sign it out"): ends every live session of that device and forgets it, so its next sign-in is a new device again.
//   identity.signin.ack        the person's own act ("It was me"): the device stops being listed.
// Everything is in memory, like the sessions: a restart or the one-hour expiry ends the sessions, so the card only ever shows live ones, and a card that outlives its session answers "already signed out".
import { loginService } from "../../lib/login-door.js";

const DEVICE = /^[A-Za-z0-9_-]{8,64}$/;
const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });
const obj = (/** @type {Record<string, any>} */ properties = {}, /** @type {string[]} */ required = []) => ({ type: "object", properties, required, additionalProperties: false });

/**
 * @param {any} ctx
 * @param {{ username: () => string | null, service?: () => any, now?: () => number }} o `username` is the owner's username on this home; `service` is the running sign-in service, or null when no door listens
 */
export function registerSignins(ctx, o) {
  const service = o.service || loginService;
  const now = o.now || Date.now;
  /** Devices whose first sign-in rang the notice, with when: only these are asked about. @type {Map<string, number>} */
  const fresh = new Map();
  /** Devices the person said were them. @type {Set<string>} */
  const vouched = new Set();
  const say = (/** @type {string} */ type, /** @type {string} */ device) => { try { ctx.events.emit(type, { device, at: now() }); } catch { /* the card follows the next read */ } };
  try { ctx.events.on("signin.new-device", (/** @type {any} */ e) => { const p = (e && e.payload) || e || {}; if (DEVICE.test(String(p.device))) fresh.set(String(p.device), Number(p.at) || now()); }); } catch { /* a bare test has no bus */ }

  const owner = () => { const u = o.username(); if (!u) throw refuse("There is no username on this home yet.", "no_identity"); return u; };
  const deviceOf = (/** @type {any} */ input) => { const d = String(input && input.device || ""); if (!DEVICE.test(d)) throw refuse("That is not a device id.", "bad_input"); return d; };

  ctx.tool("identity.signins.pending", {
    description: "The devices that signed in to this space for the first time and are still signed in, which the owner has not said were them. For the Needs you list.",
    input: obj(),
    run: async () => {
      const u = o.username(), svc = service();
      if (!u || !svc) return { devices: [] };
      /** @type {Map<string, { device: string, label: string, at: number }>} */ const byDevice = new Map();
      for (const s of svc.sessionsOf(u)) if (fresh.has(s.device) && !vouched.has(s.device) && !byDevice.has(s.device)) byDevice.set(s.device, { device: s.device, label: String(s.label || ""), at: Number(s.at) || 0 });
      return { devices: [...byDevice.values()] };
    },
  });

  ctx.tool("identity.signin.revoke", {
    description: "Sign a device out: end every live session of that device id and forget it, so its next sign-in is a new device again. The owner's own act.",
    input: obj({ device: { type: "string" } }, ["device"]),
    run: async (/** @type {any} */ input) => {
      const device = deviceOf(input), svc = service();
      if (!svc) throw refuse("No sign-in door is open on this home.", "unavailable");
      const r = svc.revokeDevice(owner(), device);
      fresh.delete(device); vouched.delete(device);
      say("signin.revoked", device);
      return { revoked: Boolean(r && r.revoked), ended: Number(r && r.ended) || 0, ...(r && r.revoked ? {} : { note: "That device was already signed out." }) };
    },
  });

  ctx.tool("identity.signin.ack", {
    description: "Say a sign-in on a new device was you: it stops waiting on you. The owner's own act.",
    input: obj({ device: { type: "string" } }, ["device"]),
    run: async (/** @type {any} */ input) => {
      const device = deviceOf(input);
      owner();
      vouched.add(device);
      say("signin.acknowledged", device);
      return { acknowledged: true };
    },
  });
}
