// kernel/remote/wire.js: what a device and a Space's home agree on for a remote kernel call (the wire shape; agreed with tailnet in CHAT.md).
//
//   request  { v: 1, space, id, ts, call, args }      call is a path in CALLS below; args are the call's arguments after the chain, as JSON
//   response { v: 1, id, ok: true, result } | { v: 1, id, ok: false, error: { code, message } }
//
// There is no chain, no person and no session in the request. WHO is calling is established by the transport (the Wink connection or the relay channel proves the
// device key) and handed to the home beside the request as `peer` ({ device_key_id, person, path }); the home's Surfaces door mints the chain from that. A chain a
// device built for itself never crosses, and nothing in `args` can name an actor.
export const WIRE_VERSION = 1;
export const MAX_REQUEST_BYTES = 256 * 1024;
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const REPLAY_WINDOW_MS = 5 * 60 * 1000;

/** The calls that cross, by gateway group. Anything not here is refused (`no_such_call`); a call is only ever looked up, never built from a name. */
export const CALLS = Object.freeze({
  grants: ["create", "revoke", "narrow", "list", "setRole", "removeMember", "transferOwner", "addActor", "members.list", "members.get", "invites.create", "invites.confirm", "invites.accept", "invites.get", "offers.offer", "offers.unoffer", "offers.lend", "offers.unlend"],
  records: ["define", "get", "query", "aggregate", "search", "create", "update", "remove", "restore"],
  tasks: ["request", "get", "start", "complete", "revise", "decide", "stuck", "skip", "unblock", "card", "needsYou"],
  events: ["read"],
  surfaces: ["open", "revoke"],
  // A member's computer running one of this Space's sessions (docs/work/runner.md, "The lent-computer wire"). `leases` is the gateway's (the lease is bound to the member, the device and its
  // key and issued only while both Offers stand); `lent` is a SERVICE the home registers (core/runner/lent-home.js): the session's definition, its transcript, files (in chunks) and checkpoints.
  leases: ["issue", "renew", "use"],
  lent: ["status", "start", "stop", "appendTranscript", "getTranscript", "putFile", "getFile", "putCheckpoint", "getCheckpoint", "usage"],
});

/** The reads a device may keep a marked copy of for its screens. */
export const CACHEABLE = Object.freeze(new Set(["grants.list", "grants.members.list", "grants.members.get", "grants.invites.get", "records.get", "records.query", "records.aggregate", "events.read", "tasks.get", "tasks.needsYou", "tasks.card"]));

/** Calls a person who is not a member yet may make: reading the join card and accepting the invite. */
export const INVITEE_CALLS = Object.freeze(new Set(["grants.invites.get", "grants.invites.accept"]));

export const pathOf = (/** @type {string} */ group, /** @type {string} */ name) => `${group}.${name}`;
export const allCalls = () => Object.entries(CALLS).flatMap(([g, ns]) => ns.map(n => pathOf(g, n)));
