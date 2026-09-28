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
boundaries, hygiene = 132/133. The one failure is pre-existing and unrelated to this branch's
diff: core/team/index.js has its own hand-rolled `PERSON = new Set(["cli","local","deck",
"capsule"])` (line 246) that isn't in cohesion's hygiene allowlist - it landed on stage via the
teammates work, after that hygiene test was written, and this is the first run of the two
together. Not touched here (not one of the three named swap targets, and core/team isn't this
branch's file to edit) - flagged to the integrator/team-lead to route to whoever owns core/team.

## Next

Send both shas to the reviewer to confirm the mcp-hub module-carve-out behaves identically, and
the config fix + swap shas to the integrator. Nothing else queued on this branch.
