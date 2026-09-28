# cohesion-callerswap

Branch: work/cohesion-callerswap · Worktree: ../vyre-cohesion-callerswap · off stage/0.1.1 9790c716
· one-off cleanup requested by the integrator (lead's stage/0.1.1 fold)

## Scope

Swap the three local person-check equivalents that were written before lib/caller.js existed
(sessions' goals, sessions' planner, federation's core/mcp/hub.js) onto the shared
lib/caller.js isPerson, now that stage/0.1.1 carries both. No behavior change intended; every
swap is meant to be provably identical, confirmed by each file's own existing tests plus the
reviewer.

## Done

- fc8cbb5a: unrelated blocker found first - core/config/index.js had a missing `/**` JSDoc
  opener (two docblocks from different merged branches, 2b9da919 and a70bffc1, got concatenated
  by the "anywhere through 7bd18024" fold, d6c80ab1, with no opener before the second paragraph).
  This is a real SyntaxError that broke every test importing core/config, i.e. almost everything
  on this stage commit - fixed with the minimal one-line restore, flagged to the integrator
  separately since it blocks everyone building on 9790c716, not just this branch.
- f2df7888: the three swaps.
  - core/goals/index.js: dropped its local `isPerson = caller => PEOPLE.includes(callerKind(caller))
    || ownerDevice(caller)`, imports isPerson from lib/caller.js instead. PEOPLE/AGENTS arrays kept
    (still feed `callers:` allowlists elsewhere in the file).
  - core/planner/index.js: dropped its local `isPerson = caller => callerAllowed(PEOPLE, caller)`
    (callerAllowed alone never refused an agent claim first - the same backwards shape reviewer
    caught in goals). Imports isPerson from lib/caller.js. PEOPLE kept (still feeds a `callers:`
    list).
  - core/mcp/hub.js: whoFrom() now calls isPerson(c) instead of its own inline claimed/PEOPLE
    check. One real behavior to preserve deliberately, not swapped away: hub.js treats a
    `module:<name>` caller (the kernel's own label, never a caller-forgeable claim) as person too,
    which lib/caller.js's isPerson does not (PERSON_SURFACES has no "module"). Kept as an explicit
    OR branch (`c.startsWith("module:") && !MODULE_CLAIM.test(c)`), MODULE_CLAIM being hub.js's
    own pre-existing claimed-regex, so a caller that smuggles an agent: or thread: claim behind
    "module:" is still refused exactly as before. Confirmed against hub.test.js's own whoFrom
    cases, incl. the reviewer's round-2 MEDIUM cases (space before "agent:", an empty-name claim,
    a thread: claim) - lib/caller.js's AGENT_CLAIM/THREAD_CLAIM already cover all of them.

testbox: core/goals/*.test.js, core/planner/*.test.js, core/mcp/*.test.js, lib/caller.test.js,
boundaries, hygiene = 132/133. The one failure was core/team/index.js's own hand-rolled
`PERSON = new Set(["cli","local","deck","capsule"])` (line 246), not in cohesion's hygiene
allowlist - landed on stage via the teammates work after that hygiene test was written, first run
of the two together. Not one of the three named targets, so left alone and flagged.

## Also done: core/team (lead's follow-up, since teammates isn't running)

db48c3ba: swapped core/team/index.js's PERSON_SURFACES copy onto lib/caller.js's isPerson too.
Full detail in docs/work/teammates.md (the owning team's own doc) - short version: one real spot
(`projectOf`'s `PERSON.has(callerKind(caller))`) had the same agent-claim-stripping bug as goals/
planner/hub; the other seven spots (`PERSON.has(String(meta.caller))`, an exact match) were
already safe against that specific bug but gained owner-device recognition they didn't have.
testbox: core/team 43/43, boundaries+hygiene 53/53 (hygiene green again). Combined re-run of
everything this branch touches: 176/176.

## Reviewer's verdict, and the hub.js fix (a065c545)

Reviewer on f2df7888: goals and planner are not identical, but strictly TIGHTER (the point) -
`isPerson` refuses an agent: or thread: claim first, so "cli agent:kit" and "cli:thread:x", which
both used to read as the person there, no longer do. Accepted; documented in both files' own
comments now instead of implying "identical".

hub.js: NOT identical, and it LOOSENS - isPerson includes isOwnerDevice, so "tailnet:alex@..." and
"device:<id>" went from person: false to person: true after the swap, and inScope() trusts
person to skip every per-agent scope check. Per ADR 0032 a script on a paired phone or tailnet
node is that owner device with no person session behind it. Lead's ruling: exclude owner devices
explicitly to keep today's behaviour exactly (`person = (isPerson(c) && !isOwnerDevice(c)) || ...`
the module branch) - admitting an owner device with a real passkey-backed person session is a
separate design for later, not 0.1.1. Added tailnet:<owner> and device:<id> cases to
hub.test.js's whoFrom tests.

testbox: goals+planner+mcp+team+caller+boundaries+hygiene = 177/177. Sent back to the reviewer.

## Next

Waiting on the reviewer's final clear on a065c545. Final sha sent to the integrator either way.
Nothing else queued on this branch.
