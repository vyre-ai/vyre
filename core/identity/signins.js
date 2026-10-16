// @ts-check
// identity/signins: the sign-ins on a new device that wait on the person (the card on Now). Every person sees their own: the sign-in service (kernel/identity/space-login.js) keeps each live session with the
// device id, its label and when, and answers by person id; this module adds what the person says about them. Three tools, each for the CALLER's person, taken from the kernel chain of the call and never from an input:
//   identity.signins.pending   the devices of yours that rang the new-device notice, still signed in, that you have not vouched for.
//   identity.signin.revoke     your own act ("Not me, sign it out"): ends every live session of that device of yours and forgets it, so its next sign-in is a new device again.
//   identity.signin.ack        your own act ("It was me"): the device stops being listed for you.
// Everything is in memory, like the sessions: a restart or the one-hour expiry ends the sessions, so the card only ever shows live ones, and a card that outlives its session answers "already signed out".
import { loginService } from "../../lib/login-door.js";

const DEVICE = /^[A-Za-z0-9_-]{8,64}$/;
const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });
const obj = (/** @type {Record<string, any>} */ properties = {}, /** @type {string[]} */ required = []) => ({ type: "object", properties, required, additionalProperties: false });

/**
 * @param {any} ctx
 * @param {{ fallbackPerson?: () => string | null, service?: () => any, now?: () => number }} o `service` is the running sign-in service, or null when no door listens; `fallbackPerson` is only for a build with no
 *   kernel (development), where the home's own person is the only one there is
 */
export function registerSignins(ctx, o) {
  const service = o.service || loginService;
  const now = o.now || Date.now;
  /** Devices whose first sign-in rang the notice, with when: only these are asked about. @type {Map<string, number>} */
  const fresh = new Map();
  /** Devices a person said were them, by `person:device`. @type {Set<string>} */
  const vouched = new Set();
  const say = (/** @type {string} */ type, /** @type {string} */ device) => { try { ctx.events.emit(type, { device, at: now() }); } catch { /* the card follows the next read */ } };
  try { ctx.events.on("signin.new-device", (/** @type {any} */ e) => { const p = (e && e.payload) || e || {}; if (DEVICE.test(String(p.device))) fresh.set(String(p.device), Number(p.at) || now()); }); } catch { /* a bare test has no bus */ }

  /** The person this call is, from the kernel's chain for it: exactly one hop that is a person. Never a label, never an input. */
  const personOf = async (/** @type {any} */ meta) => {
    if (!ctx.kernel || typeof ctx.kernel.chain !== "function") { const f = o.fallbackPerson && o.fallbackPerson(); if (f) return f; throw refuse("This is for a signed-in person.", "person_required"); }
    const chain = await ctx.kernel.chain(meta).catch(() => null);
    const hop = chain && Array.isArray(chain.hops) && chain.hops.length === 1 ? chain.hops[0] : null;
    if (!hop || !hop.actor || hop.actor.kind !== "person" || !/^per_[a-z2-7]{26}$/.test(String(hop.actor.id))) throw refuse("This is for a signed-in person.", "person_required");
    return String(hop.actor.id);
  };
  const deviceOf = (/** @type {any} */ input) => { const d = String(input && input.device || ""); if (!DEVICE.test(d)) throw refuse("That is not a device id.", "bad_input"); return d; };

  ctx.tool("identity.signins.pending", {
    description: "Your sign-ins on a new device that are still signed in and that you have not said were you. For the card on Now. Each person sees their own.",
    input: obj(),
    run: async (/** @type {any} */ _input, /** @type {any} */ meta) => {
      const person = await personOf(meta), svc = service();
      if (!svc) return { devices: [] };
      /** @type {Map<string, { device: string, label: string, at: number }>} */ const byDevice = new Map();
      for (const s of svc.sessionsOfPerson(person)) if (fresh.has(s.device) && !vouched.has(`${person}:${s.device}`) && !byDevice.has(s.device)) byDevice.set(s.device, { device: s.device, label: String(s.label || ""), at: Number(s.at) || 0 });
      return { devices: [...byDevice.values()] };
    },
  });

  ctx.tool("identity.signin.revoke", {
    description: "Sign one of your devices out: end every live session of that device id and forget it, so its next sign-in is a new device again. Your own act.",
    input: obj({ device: { type: "string" } }, ["device"]),
    run: async (/** @type {any} */ input, /** @type {any} */ meta) => {
      const device = deviceOf(input), person = await personOf(meta), svc = service();
      if (!svc) throw refuse("No sign-in door is open on this home.", "unavailable");
      const r = svc.revokeDeviceOfPerson(person, device);
      vouched.delete(`${person}:${device}`);
      say("signin.revoked", device);
      return { revoked: Boolean(r && r.revoked), ended: Number(r && r.ended) || 0, ...(r && r.revoked ? {} : { note: "That device was already signed out." }) };
    },
  });

  ctx.tool("identity.signin.ack", {
    description: "Say a sign-in on a new device was you: it stops waiting on you. Your own act.",
    input: obj({ device: { type: "string" } }, ["device"]),
    run: async (/** @type {any} */ input, /** @type {any} */ meta) => {
      const device = deviceOf(input), person = await personOf(meta);
      vouched.add(`${person}:${device}`);
      say("signin.acknowledged", device);
      return { acknowledged: true };
    },
  });
}
