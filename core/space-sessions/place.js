// core/space-sessions/place.js: where may this session run? The Space's server always. A member's own computer only when BOTH grants exist:
// the Space admin's offer (the Space may ask for work to run on members' computers) and the member's own accept for that one device.
// Both are kernel grants (contract 6.2). The accept names the person's own sessions on the person's own device and nothing else, so the
// admin can run nothing on the computer and see nothing in it.

export const RUN_OFFER_ACTION = "sessions.run-on-member-device";
export const RUN_ACCEPT_ACTION = "sessions.host-for-space";

const livePast = (/** @type {any} */ g, /** @type {number} */ now) => g.status === "active" && !(g.conditions && g.conditions.when && g.conditions.when.expires <= now);
const names = (/** @type {any} */ g, /** @type {string} */ action) => g.actions.some((/** @type {string} */ a) => a === action || a === "sessions.*" || a === "*");
const same = (/** @type {any} */ a, /** @type {any} */ b) => Boolean(a && b) && a.kind === b.kind && a.id === b.id;
const deviceUrn = (/** @type {string} */ space, /** @type {string} */ id) => `vyre://${space}/device/${id}`;
const covers = (/** @type {any} */ g, /** @type {string} */ urn) => { const p = g.resource.prefix; return p.endsWith("*") ? urn.startsWith(p.slice(0, -1)) : p === urn; };

/**
 * @param {{ grants: { list(space: string): any[] | Promise<any[]> },
 *   isAdmin(space: string, actor: any): boolean | Promise<boolean>,
 *   deviceOwner(device: string): any | Promise<any>, clock?: () => number }} ports
 */
export function createPlacement(ports) {
  const clock = ports.clock || Date.now;
  /** @param {{ space: string, person: any, device?: string, session_owner?: any }} q @returns {Promise<{ where: 'server' | 'device', reason: string, grants?: string[] }>} */
  async function placeSession(q) {
    if (!q.device) return { where: "server", reason: "no device asked for: the Space's server" };
    if (q.session_owner && !same(q.session_owner, q.person)) return { where: "server", reason: "a member's computer runs only that member's own sessions" };
    const owner = await ports.deviceOwner(q.device);
    if (!same(owner, q.person)) return { where: "server", reason: "that device is not this person's" };
    const now = clock();
    const rows = (await ports.grants.list(q.space)).filter(g => g.space === q.space && livePast(g, now));
    let offer;
    for (const g of rows) if (names(g, RUN_OFFER_ACTION) && (await ports.isAdmin(q.space, g.issuer))) { offer = g; break; }
    const accept = rows.find(g => names(g, RUN_ACCEPT_ACTION) && same(g.issuer, q.person) && g.subject.kind === "actor" && g.subject.actor.kind === "service" && g.subject.actor.space === q.space && covers(g, deviceUrn(q.space, q.device)));
    if (!offer) return { where: "server", reason: "the Space has not offered to run work on members' computers" };
    if (!accept) return { where: "server", reason: "you have not accepted running this Space's work on this computer" };
    return { where: "device", reason: "both the Space's offer and your accept exist", grants: [offer.id, accept.id] };
  }
  return Object.freeze({ placeSession });
}

/** The two grants as inputs, so a card or a test builds them one way. @param {{ space: string, admin: any, person: any, device: string, expires: number }} o */
export function offerGrant(o) {
  return { subject: { kind: "role", name: "member" }, actions: [RUN_OFFER_ACTION], resource: { prefix: `vyre://${o.space}/device/*` }, conditions: { when: { expires: o.expires } }, issuer: o.admin, source: "wink:run-work" };
}
export function acceptGrant(o) {
  return { subject: { kind: "actor", actor: { kind: "service", id: "space-sessions", space: o.space } }, actions: [RUN_ACCEPT_ACTION], resource: { prefix: deviceUrn(o.space, o.device) }, conditions: { when: { expires: o.expires } }, issuer: o.person, source: "wink:accept-work" };
}
