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
  grants: ["create", "revoke", "narrow", "list", "setRole", "removeMember", "transferOwner", "addActor", "members.list", "members.get", "invites.create", "invites.confirm", "invites.accept", "invites.get", "invites.list", "invites.revoke", "offers.offer", "offers.unoffer", "offers.lend", "offers.unlend"],
  // A project moving out to another Space: approved once, with the person's own proof (the source's sealing process checks it); the receiving side and the finish are the spaces module's tools.
  moves: ["out", "outMany"],
  // the Store calls of a team member's app (list, me, actors, types, events) are the member door's rows (core/work/member-tools.js); get, create and update answer in the gateway's shape and, with the Store's keys, in the Store's
  records: ["definitions", "define", "get", "reference", "query", "aggregate", "search", "create", "update", "remove", "restore", "list", "me", "actors", "types", "events"],
  memory: ["file", "recall", "retire"],
  tasks: ["request", "get", "start", "complete", "revise", "decide", "stuck", "skip", "unblock", "card", "needsYou", "list", "move", "submit"],
  events: ["read"],
  // A sealed value goes to the HOME's sealing process, never into the record: the person's own act on a space on a server (reveal carries the person's proof for the home's own challenge: the home checks it at its sealing process)
  seal: ["put", "reveal", "wrapKey", "import"],
  surfaces: ["open", "revoke"],
  // A member's computer running one of this Space's sessions (team/archive/work-journals/runner.md, "The lent-computer wire"). `leases` is the gateway's (the lease is bound to the member, the device and its
  // key and issued only while both Offers stand); `lent` is a SERVICE the home registers (core/runner/lent-home.js): the session's definition, its transcript, files (in chunks) and checkpoints.
  leases: ["issue", "renew", "use", "reinstate"],
  lent: ["whoami", "status", "start", "stop", "appendTranscript", "getTranscript", "putFile", "getFile", "putCheckpoint", "getCheckpoint", "usage", "beat", "release", "pipe", "preview", "wait", "http"],
  // The sidebar each member arranges (SPEC-0.3.0 part 9): a SERVICE the home registers (core/sidebar/service.js). A member reads the Space's default with their own list on top and changes their own list; only the Space's owner or admin role changes the default.
  sidebar: ["get", "edit", "team"],
  // A member's own chats on the team's server (0.3.3 J9): a SERVICE the home registers (core/work/chat-service.js). The call runs the work module's chat tool in THIS Space, as the member's own chain: their pinned
  // assistant, the chats they are in, starting one. A member never reaches a registry tool; the list of calls is fixed here.
  // A member's own AI sign-in on the team's server (0.3.3 G03; core/sessions/accounts-service.js): a login of theirs, run as its own user, serving only their turns. A key needs a Vault of their own (0.3.4).
  accounts: ["list", "signin", "remove", "default"],
  // A member's own skills on the team's server (0.3.3 G03; core/skills/member-service.js): her personal skill is drafted and approved by her alone, a draft at a higher level waits for its owner, and only skills (no plugins).
  skills: ["list", "get", "draft", "approve", "versions"],
  flows: ["cheatsheet", "compile-text", "list", "health", "get", "card", "code", "graph", "diff", "describe", "define", "patch", "from-chat", "test-save", "test-remove", "test-list", "test-run", "simulate", "start", "runs", "run", "timeline", "attention", "cancel", "retry", "approve", "propose"],
  // A member starts her own projects on the team's server (0.3.3; core/work/member-projects.js): the installed templates, a blank project, a project from a template.
  work: ["templates", "project-create", "start-project", "timeline"], team: ["list"],
  // A member's project files (0.3.3; core/work/member-files.js): list, read and upload in one project's files area.
  files: ["list", "read", "upload"],
  chat: ["persistent", "pin", "list", "get", "create", "send", "catchup", "typing", "react", "pin-message", "reply-mode", "mark-read", "read", "answer", "stop"],
});

/** The reads a device may keep a marked copy of for its screens. */
export const CACHEABLE = Object.freeze(new Set(["grants.list", "grants.members.list", "grants.members.get", "grants.invites.get", "records.definitions", "records.get", "records.query", "records.aggregate", "events.read", "tasks.get", "tasks.needsYou", "tasks.card"]));

/** Calls a person who is not a member yet may make: reading the join card and accepting the invite. */
export const INVITEE_CALLS = Object.freeze(new Set(["grants.invites.get", "grants.invites.accept"]));

export const pathOf = (/** @type {string} */ group, /** @type {string} */ name) => `${group}.${name}`;
export const allCalls = () => Object.entries(CALLS).flatMap(([g, ns]) => ns.map(n => pathOf(g, n)));

/**
 * Presence over the wire (lead ruling, 4 Oct): an act that needs the owner's presence is asked with no proof first; the home answers `needs_presence` with a CHALLENGE
 * `{ call, space, home, nonce, expires, args_hash, op?, fields?, payload_hash? }` (op, fields and payload_hash when the call is one a presence proof covers, kernel/remote/proof.js).
 * The device signs it with its own presence key and resends the same call with `proof` (the kernel's PresenceProof, at most 4 KB) and `challenge` (the nonce) beside the args, never inside
 * them. The home checks the nonce (its own, live, for this device, call and arguments, used once) and hands the proof to the kernel's one verifier, which checks the key, the role and the hash.
 * The peer session alone is never presence and the home never signs for the person.
 */
export const MAX_PROOF_BYTES = 4096;
export const CHALLENGE_TTL_MS = 2 * 60 * 1000;
export const PRESENCE_CODES = Object.freeze(new Set(["needs_presence", "presence_required"]));
