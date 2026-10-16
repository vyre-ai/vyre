// @ts-check
// The person a module relays: which module may relay which tool on the first run, and the proven facts a relayed call carries.
// Kept out of index.js so the registry stays under its size cap.
import { modelCaller } from "./needs-you-hold.js";

/** Modules that relay the asking person on the person's own surface. First-run and pair-install run before a session token exists, so onboard and identity relay from the surface itself. */
export const FIRST_RUN_RELAY = Object.freeze({
  // mentions replays the asking person's session to each provider's search/resolve (ingress tags, # picker).
  mentions: ["vault.mention.search", "vault.mention.resolve"],
  identity: ["spaces.identity.create", "vault.master.install", "spaces.identity.self", "spaces.identity.device", "spaces.identity.published-key"], // identity.create claims the name; vault.master.install installs the held key
  // First-run and pair-install run on the person's surface: they relay the caller to identity, spaces, wink, vault and devices tools.
  onboard: ["spaces.list", "spaces.invites.", "identity.", "wink.install.", "vault.space.create", "vault.put", "vault.", "link.", "relay.", "devices.signin", "wink.phone.open", "sessions.accounts.", "onboard."],
});

/**
 * The facts a `{ relay: true }` call carries, or null when no person is on the call. Onboard and identity relay from the person's own surface before a
 * session token exists; every other module needs proven facts or a token.
 * @param {string} moduleName @param {any} cur the current call @param {{ isPerson: (as: string) => boolean, captureOrigin: () => any }} deps
 * @returns {{ origin: any, relayed: Record<string, any> } | null}
 */
export function relayedPerson(moduleName, cur, deps) {
  if (!cur) return null;
  const personSurface = deps.isPerson(String(cur.caller)) && !modelCaller(String(cur.caller));
  if (!(cur.kernelFacts || typeof cur.token === "string" || ((moduleName === "onboard" || moduleName === "identity") && personSurface))) return null;
  const origin = deps.captureOrigin() || (personSurface ? String(cur.caller) : undefined);
  const relayed = { ...(cur.kernelFacts ? { kernelFacts: cur.kernelFacts } : {}), ...(typeof cur.token === "string" ? { token: cur.token } : {}), ...(typeof cur.viaMcp === "string" && cur.viaMcp ? { viaMcp: cur.viaMcp, ...(cur.viaMcpHosted === true ? { viaMcpHosted: true } : {}) } : {}) };
  return { origin, relayed };
}

/** The tools the agents module may call as the asking person: agents.ask's words and tags, heard by threads.send, and giving the keyboard back (threads.release) once the ask is answered, which only lets go of the asker's own lease. @param {string} tool */
export const agentsMayRelay = tool => tool === "threads.send" || tool === "threads.release";
/** The per-call check on the agents module's relay: throws for any tool but threads.send. @param {string} tool @param {string} as */
export function checkAgentsRelay(tool, as) {
  if (!agentsMayRelay(tool)) throw new Error(`agents may not call ${tool} as ${as}: it relays a person to threads.send and threads.release only`);
}

/** Whether a module's `{ as }` call carries this turn's proven person: any person caller, the sessions and assistant modules replaying one for mentions and threads, and agents for threads.send and threads.release. */
export const carriesPerson = (/** @type {string} */ moduleName, /** @type {any} */ as, /** @type {string} */ tool, /** @type {(as: string) => boolean} */ isPerson, /** @type {(tool: string) => boolean} */ agentsMayRelay) => {
  const replay = String(as) === "module:sessions" || String(as) === "module:assistant";
  return Boolean((as && isPerson(String(as))) || (moduleName === "mentions" && replay) || ((moduleName === "threads" || moduleName === "switchboard") && replay) || (moduleName === "agents" && agentsMayRelay(tool)));
};
