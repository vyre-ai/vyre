// @ts-check
// lib/caller: the one "is this the person?" check every module should read instead of writing
// its own. Pure, no feature state (any part may import a lib, test/boundaries.test.js's rule);
// composes core/modules (agentClaim, ownerDevice, callerKind) and core/presence (PERSON_SURFACES),
// both kernel, rather than re-deriving any of their regexes a third or eighth time.
//
// The recurring bug this replaces: a module checks "no agent name means the person" - the
// NEGATION of isAgent, not a positive owner check - which lets in a bare model session ("mcp"),
// the harness ("harness"), a guest ("tailnet-guest:...") and a hook ("hook"), none of which is the
// person's own surface or device. Every one of core/memory, core/recall and core/files kept a
// version of this same mistake independently (cohesion audit, 2026-09-28) before this existed;
// core/projects/index.js's teammates code and core/link's own checks are two more copies of the
// same idea under different names (isAgent, tailnetLogin) that this does not yet replace, since
// this is a lib for NEW and FIXED callers to use, not a mandate to touch every file that already
// has one (RULES: don't edit another team's module - send its owner the line instead).
//
// isPerson checks the agent claim FIRST and refuses immediately if one exists, deliberately not
// merely "whatever's left after ruling out an agent": a caller shaped "cli:agent:kit" reads its
// own callerKind as "cli" (PERSON_SURFACES has that), which is exactly the transport-spoofing gap
// e2e found in hands-desktop's own resolveAgent before agentClaim became the one parser for it
// (2026-09-28). An agent's own claim, however it is carried, is never the person, whatever kind
// its transport otherwise reads as.

import { agentClaim, ownerDevice, deviceLabel, spaceLabel, callerKind } from "../core/modules/index.js";
import { PERSON_SURFACES } from "../core/presence/index.js";

/** callerKind strips "thread:" the same as "agent:" (a Vyre-owned session, ADR 0030), so
 * "cli:thread:x" reads its own callerKind as "cli" and would pass PERSON_SURFACES same as a real
 * person's own "cli" — only mcp and harness make thread labels today (e2e2, 2026-09-28), but
 * nothing stops another surface from carrying one, so isPerson refuses any thread label directly
 * rather than trusting that today's callers happen not to. Kept local to this lib (not added to
 * core/modules' agentClaim) since a thread claim is not an *agent* claim - isAgent/agentName stay
 * exactly what they were. */
const THREAD_CLAIM = /(?:^|[\s:])thread:/;

/** The caller string out of a bare string or a `{caller}` meta object - most modules' run()
 * gets `(input, {caller})`, some pass the plain string through their own helpers. */
const callerOf = meta => (typeof meta === "string" ? meta : String((meta && meta.caller) || ""));

/** The agent name a caller claims ("mcp:agent:kit", "cli:agent:kit", ...), or null when it names
 * no agent at all. @param {string|{caller?: string}} meta */
export const agentName = meta => agentClaim(callerOf(meta));

/** Whether `meta` claims to be an agent's own thread, in any transport shape. @param {string|{caller?: string}} meta */
export const isAgent = meta => agentName(meta) !== null;

/** Whether `meta` is the owner's own device reached over the tailnet or a relay pairing
 * (`tailnet:<login>`, `device:<id>`) - a person who may ask, though HUMAN_ONLY still needs its
 * own proof regardless. @param {string|{caller?: string}} meta */
export const isOwnerDevice = meta => ownerDevice(callerOf(meta));

/** Whether `meta` is a device paired through Wink or the relay, exactly `device:<id>`. Exact: `Device:`, `device :x`, `device:` and a label with a zero-width character are not. @param {string|{caller?: string}} meta */
export const isDevice = meta => deviceLabel(callerOf(meta));

/** The id in a `device:<id>` label (1 to 64 of A-Z a-z 0-9 _ -), or null for any other label. Bookkeeping only: it names WHICH device, it never says the caller is the person (isPerson, the kernel chain). @param {string|{caller?: string}} meta @returns {string|null} */
export const deviceIdOf = meta => { const m = /^device:([A-Za-z0-9_-]{1,64})$/.exec(callerOf(meta)); return m ? m[1] : null; };

/** Whether `meta` is a visiting person in a Space, exactly `space:<person>@<space>` (SPEC-wink-network 5.2). Never the person themself on their own box: isPerson is false for it. @param {string|{caller?: string}} meta */
export const isSpaceMember = meta => spaceLabel(callerOf(meta));

/**
 * Whether `meta` is the person: one of PERSON_SURFACES (cli, local, deck, capsule) or the owner's
 * own device. Never the negation of isAgent - a bare model session ("mcp"), the harness
 * ("harness"), a guest ("tailnet-guest:...") or a hook ("hook") all correctly read false here
 * without ever being checked against "is this an agent", exactly the class of caller "no agent
 * name means the person" used to let in.
 *
 * Reviewer nit (2026-09-28, closed): a caller shaped "cli:thread:x" used to read true here on the
 * strength of vyred's own asTaken relabeling a thread running under a model to "mcp:thread:x"
 * before it reached any caller check. That held only as long as every thread label happened to
 * arrive already relabeled; isPerson now refuses a thread label itself (THREAD_CLAIM, e2e2's fix
 * to core/link/mac.js's kindOf, 2026-09-28) instead of depending on that upstream behavior.
 * @param {string|{caller?: string}} meta
 */
export function isPerson(meta) {
  const caller = callerOf(meta);
  // an agent's own claim, or a thread label (mcp/harness's own session shape, ADR 0030), is never the person
  if (agentClaim(caller) !== null || THREAD_CLAIM.test(caller)) return false;
  return PERSON_SURFACES.has(callerKind(caller)) || ownerDevice(caller);
}
