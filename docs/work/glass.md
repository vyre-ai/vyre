# glass

Branch: work/glass · Worktree: ../vyre-glass · Design: [ADR 0005](../adr/0005-glass.md)

## Proposal

Glass becomes a real module and a real set of Deck views, on top of computers rather than beside
it. You open an agent's computer (or the box) from the Deck, the Capsule or the phone; you watch
it live; you take the keyboard with Touch ID or Face ID and hand it back; you sign in to a site in
the agent's Chrome with the agent's eyes and hands shielded; you browse, preview, upload,
download and move files on the agent's computer and the box.

## Scope

- `core/glass/`: the `glass` module (targets, sessions, take and release with presence, files
  with one guard and two ticketed byte streams).
- `deck/glass/`: watch, take-over, sign-in, files and phone views; noVNC vendored.
- computerd `/fs` routes, contributed to the computers image.
- Capsule "Open Glass" for a thread, with the capsule session.

## Done when

On the box stack, an agent's computer runs Chrome; the Deck at 1440 and 390 shows it live; a
person takes over, types and hands back; the file browser lists, previews, uploads and downloads
in the agent's home and a box folder; secret paths are refused; everything is torn down after.

## Done

- ADR 0005 and this design.
- `core/glass`, `deck/glass`, the Capsule entry, `/glass/:name` in the Deck.
- computers additions: `computers.helper`, `computers.shield`, computerd `/fs` (sent to computers
  for review).
- Live on the box (26 Sep): Chrome in an agent's computer watched in the Deck at 1440 and 390, a
  take-over with typing that arrived and a non-holder's input dropped, the private shield through
  the API, files on the agent's computer and a box folder with preview, a one-use download and
  uploads, `.env` and `.ssh` hidden. Frozen and unwatched: vyred idle at 0 CPU ticks in 30 s,
  81 MB RSS; one viewer: about 0.3% for vyred and 1 to 1.5% for the computer; it froze again
  about 75 s after the viewer left. Everything created for the run was removed.

## Next

- Reviewer's HIGH on 1ae6fe9e (Chrome's FIFOs pre-plantable via /tmp/vyre-chrome + xterm's
  .bashrc race) fixed at 0a07c6a3: CHROME_DIR moves to /var/lib/vyre/chrome-pipes (vyre's own
  volume, agent's uid can't write there), created early in entrypoint.sh before as_agent's xterm,
  fails closed (bare mkdir, symlink/owner checks, `|| exit 1` on every chgrp/chmod/mkfifo). Bounding-
  set gap accepted as a documented residual (no SETPCAP). Live-verified on a throwaway compose
  project (vyre-glass-throwaway, own network, no ports, never /srv/vyre) on testbox: 13/13
  isolation.test.js pass, 0 fail, 0 skipped, including the new FIFO test and the shielded-freeze
  test. Stack fully torn down after. Sent to the reviewer, integrator and team-lead.
- Reviewer's second HIGH on 2c55a4ae fixed at 2ebb5034: /var/lib/vyre is the computer's own named
  volume, kept across stop/start and a Docker restart, so a first boot's own chrome-pipes/ was
  refusing every later boot. Fixed exactly as specified: `rm -rf` the dir (safe, vyre's own 0711,
  nothing but vyre/root could have left anything there) right before the bare mkdir, checks after
  it unchanged. Live-verified on a fresh throwaway compose stack: first boot correct, then
  `docker restart` (the reviewer's exact repro) comes back running, no refusal in the logs, fresh
  FIFOs, computerd answering the shield endpoint, isolation.test.js 13/13 pass against the
  restarted container. Torn down after. Sent to the reviewer.
- Agent-browsers slice 2 started (3f03ddb0): per-agent `Target.createBrowserContext` scoping in
  `cdpmux.js`, the concrete new mechanism docs/design/agent-browsers.md's level 2 needs. An "agent"
  client can join with an `agentName`; the mux gets or creates that name's own browser context and
  reuses it, forces `Target.createTarget` onto it (inject if absent, refuse if it names another),
  and fences `Target.attachedToTarget`/`targetCreated`/`targetInfoChanged`/`targetDestroyed`/
  `getTargets` to the caller's own context (all browser-wide in real CDP, not per-context).
  `kind: "fill"` untouched. Tests: cdpmux.test.js 25/25 (8 new); testbox `core/computers' own test files`
  222/222 pass, 9 skipped (container-only). Not yet built: the "browser" computer kind in
  pool.js/driver/policy.js, on-disk context-profile persistence, hands-chrome/deck-glass wiring --
  next slices, per the design's own build list.
- Reviewer review of 3f03ddb0 (dormant, index.js:461 passes no agentName yet) found 4 real
  agent-vs-agent isolation gaps, all fixed at b914fd3a: H1 generalized the browserContextId check
  from just Target.createTarget to any method that takes one (Storage.setCookies/clearCookies,
  Browser.grantPermissions/resetPermissions, setDownloadBehavior), plus refusing
  Target.getBrowserContexts outright; H2 added a targetContext-backed check for the target-id
  methods (attachToTarget/closeTarget/activateTarget/getTargetInfo), unknown-refused; M1 fixed the
  event fence's fail-open (undefined context now drops, not just a known mismatch) and, in fixing
  it, found and fixed a real fan-out race (Chrome delivers targetDestroyed once per subscribed
  session; deleting targetContext on the first delivery blinded the target's own owner's later
  one -- fixed by never deleting, a documented bounded residual, plus learning context from the
  createTarget response itself, not only from an event); M2 refused
  Target.setAutoAttach{waitForDebuggerOnStart} for scoped clients (a real DoS otherwise). Tests:
  cdpmux.test.js 32/32 (7 new); testbox core/computers' own test files 229/229 pass, 9 skipped. Still
  dormant and unwired -- wiring needs agentName from computerd's own authenticated identity, never
  the client, and refusing an unscoped agent client in shared mode (reviewer's note, not yet done).
- Authenticated per-agent identity, at ba1f766d: computerd/index.js's identifyClient() is now the
  one place a token becomes a CDP identity. AGENT_TOKENS_FILE ("name=token" lines, vyred's own
  doing once the browser kind writes it) switches a computer into shared mode; any pair at all
  turns off the bare owner token's old "agent" identity for CDP purposes (the reviewer's unscoped-
  client note), while /fs and POST /shield stay owner-token-only in either mode. A malformed file
  refuses to start. entrypoint.sh passes AGENT_TOKENS_FILE unconditionally; no writer exists yet
  (ENOENT -> shared off, unchanged for every computer today, not logged as an error). Live-verified
  on a throwaway compose stack (vyre-glass-identity) against the REAL image and real Chrome: two
  real agents each saw only their own target in Target.getTargets and were refused (-32000)
  reaching each other's by id; isolation.test.js 13/13 pass on the same container after. Tests:
  index.test.js 12/12 (6 new); testbox core/computers' own test files 234/234 pass, 9 skipped. Sent to
  the reviewer. Next: the "browser" computer kind in pool.js/driver/policy.js, which is what will
  actually write .agent-tokens for a real shared computer.
- Reviewer's 2 MEDIUMs on b914fd3a fixed at 9d2d20e8, required before the browser kind turns
  shared mode on: M3 -- omitting browserContextId is not neutral (Chrome defaults to the browser's
  own default context, where fill and unscoped clients live); OPTIONAL_CONTEXT_METHODS now pins the
  agent's own context in for Storage.setCookies/clearCookies, Browser.grantPermissions/
  setPermission/resetPermissions and Browser.setDownloadBehavior, and any other Browser/Storage
  call with no context is refused (CONTEXT_READONLY_METHODS excepted, e.g. Browser.getVersion). M4
  -- Target.autoAttachRelated was missing from H2's TARGET_ID_METHODS enumeration (the same pause
  DoS as M2); added, and the waitForDebuggerOnStart refusal now covers any method that carries it.
  Tests: cdpmux.test.js 35/35 (3 new); testbox core/computers' own test files 237/237 pass, 9 skipped.
  ba1f766d (identity) is SIGNED OFF by the reviewer and may land. Still gating the browser kind:
  .agent-tokens' own permissions (0400 vyre, archive-API, tested), revocation (reload the map and
  close live clients, or restart, when an agent is dropped), and the shield's shared-mode semantics
  (undecided -- does it lock every agent while one signs in).
- Gate item 2 done at a7c1793a: .agent-tokens as an archive-API write, same shape as .boot
  (policy.js AGENT_TOKENS/agentTokensTar/allowAgentTokensTar, generalized for a variable multi-line
  body). driver/docker.js seedAgentTokens() + fake.js + the Driver typedef. dockerproxy/proxy.js's
  own archive-route check -- the real enforcement point -- now tries allowBootTar and
  allowAgentTokensTar on a seed body (the tar's own filename tells them apart, the query path is
  identical for both); a policy with no allowAgentTokensTar just never allows .agent-tokens
  through, .boot unaffected. isolation.test.js's two existing live secrets checks (browser uid,
  agent uid) extended to probe .agent-tokens too. Tests: 111 pass locally, 9 skipped; testbox
  core/computers' own test files + dockerproxy: 257/257 pass. Live-verified on a fresh throwaway
  compose stack (vyre-glass-perms) with a real .agent-tokens seeded: isolation.test.js 13/13 pass
  against the real container, confirming neither the browser nor the agent uid can read it.
  Lead's decision on gate item 4 (the shield): every agent pauses while one signs in, matches
  today's mux.closeKind("agent") unchanged -- no code needed.
- Gate item 3 done at 8ea87af4: cdpmux.closeAgent(name) (closeKind's own shape, by agent name);
  computerd POST /agents/reload (owner-token only) re-reads AGENT_TOKENS_FILE and closes any
  agent whose OLD (token, name) pair the new map no longer matches identically -- covers a plain
  removal and a rotation (the same name, a different token) alike. AGENT_MODE (was inline as
  "SHARED") is now a sticky flag decided once from whether the file existed at start, never from
  the env var's mere presence (entrypoint.sh passes it unconditionally) or from the map's current
  size (a shared computer with its last agent just revoked must not fall back to the bare owner
  token as an unscoped identity). Tests: index.test.js 14/14 (2 new: plain revocation, rotation).
  Live-verified on a fresh throwaway compose stack (vyre-glass-revoke) against the real image: two
  real agents connected, .agent-tokens rewritten via docker cp (mirroring vyred's own archive-API
  write) while bob's own live WebSocket stayed open, then /agents/reload as the owner closed
  exactly bob's session, left alice's untouched and working, and refused bob's now-revoked token a
  new connection while alice's still worked.
- Reviewer's re-review of 9d2d20e8/f03f13b0 (M3/M4) cleared them, and found one more: M5 -- the
  browser-level session (no sessionId) carries browser-WIDE domains (Tracing.start/end, IO.read,
  Extensions.loadUnpacked) neither fence touched. Fixed at f0b6b852: flipped to an allowlist for a
  scoped client's session-less calls (Target.*, Browser.getVersion, OPTIONAL_CONTEXT_METHODS;
  everything else refused). Same commit also closes 3 of the reviewer's 6 revocation points not
  yet done: an empty/missing reload is refused, not applied (shared mode + the previous map both
  kept); reloadAgentTokens() never process.exit()s, only readAgentTokens() (startup) does;
  closeAgent() now disposes the revoked agent's BrowserContext and deletes its contextStore entry,
  so a reused name never inherits a fired agent's cookies. Tests: cdpmux.test.js 38/38 (3 new),
  index.test.js 16/16 (2 new). All green locally; testbox was frozen for the integrator's rc.2
  suite this pass, so no throwaway-stack or full-suite run there yet -- owed once the freeze lifts.
  All 4 gate items plus M5 and the revocation checklist are now closed. The shared-computer schema
  shape (team-lead steer: add a kind column to computers_computers, a separate members table,
  existing rows untouched) is next, sent to the lead and reviewer together before any pool.js code.
- Reviewer's re-review (28 Sep, after M5/f0b6b852 landed) found revocation point 4 was fixed the
  wrong way: closeAgent auto-disposing the context on revoke and on rotation conflicts with the
  lead's ruling that deletion is a person-previewed, explicit action, never automatic. Fixed at
  2d0b8685: AGENT_TOKENS_FILE lines are now "id:name=token" (vyred's own unique agent id, never
  reused; name is display-only and MAY repeat). cdpmux's contextStore/addClient/closeAgent are
  keyed by agentId; closeAgent reverts to closing clients only; a new disposeAgentContext(agentId)
  is the only thing that ever deletes a context, wired to a new owner-only POST /agents/dispose
  that vyred calls only after a person has previewed the deletion. Tests: cdpmux.test.js 44/44,
  index.test.js 18/18 (id:name=token throughout, a duplicate-display-name-is-fine test, a
  dedicated /agents/dispose test). Live-verified on a fresh throwaway stack (vyre-glass-idcontext)
  against the real image: revoking kit-1 closed its live WebSocket without touching its context;
  disposing it afterward (the separate action) actually destroyed it; re-adding the same id with a
  rotated token then got a genuinely fresh context (its earlier target was gone, not just
  invisible). testbox core/computers' own test files + dockerproxy: 268/268 pass, 9 skipped -- freeze
  lifted mid-pass, both the targeted suite and the live run are now done. Sent to the reviewer.
- Reviewer's MEDIUM at 09de900b: policy.js's own AGENT_TOKENS_LINE/agentTokensTar/
  allowAgentTokensTar had stayed on "name=token" after computerd moved to "id:name=token"
  (2d0b8685) -- in the real path (driver writes, proxy checks, computerd reads) the two would
  never have agreed; every earlier live run used docker cp, which bypasses the proxy, so this
  never showed up there. Fixed: all three take {id, name, token} now, ids/tokens unique, a
  repeated display name across two ids explicitly fine. Added the shared-fixture test the reviewer
  asked for (policy.test.js): isolates computerd/index.js's own parseAgentTokens by source (a
  sandboxed Function, no server, no side effects) and feeds it exactly what agentTokensTar/
  allowAgentTokensTar produce and accept, so the two can't drift apart again silently. Tests:
  policy.test.js 21/21 (1 new), docker.test.js + proxy.test.js 31/31. Live-verified THIS time
  through the real path the reviewer named: stood up the real dockerproxy (real policy.js) in
  front of the real docker.sock on testbox, called DockerDriver.seedAgentTokens against it (not
  docker cp), booted the real image against the result -- computerd started clean, no refusal,
  and alice's token answered a real /cdp/json/version 200. testbox core/computers' own test files +
  dockerproxy: 269/269 pass, 9 skipped. Stack torn down after. Sent to the reviewer.
- pool.js's own "browser" computer kind built against the lead's signed-off schema (0a440416,
  572b58e9): a `kind` column (existing rows untouched), `computers_members(computer_id, agent_id
  UNIQUE, agent_name, generation, added_at)`, no token column -- a member's token is derived
  on demand (HMAC-SHA256 of computerId|agentId|generation under a vault-held key, never stored).
  addAgent/removeAgent both reseed+reload computerd; ensure() seeds a browser-kind container's
  identity file BEFORE its every start, not after (AGENT_MODE is decided once, at computerd's own
  first read, and never revisited). The last member's removal stops the container and keeps its
  volume; deletion is disposeContext (POST /agents/dispose), separate and explicit. A real bug
  the tests caught before anything shipped: removeAgent's non-last-member path originally only
  reloaded, never reseeded, so a removed agent's token would have kept working. Fixed.
  Tests: pool.test.js 35/35 (8 new, a real local HTTP server standing in for computerd).
  Live-verified fully end to end on testbox: real docker.sock, real dockerproxy, real
  DockerDriver, real Pool, real image, real computerd -- addAgent/removeAgent/disposeContext all
  exercised for real, catching one more bug live (computerd's own startup lag behind the VNC
  probe ensure() already waits for; fixed with a bounded connection retry, _helperFetch).
  Volumes confirmed still present after the last member's removal. Stack torn down after.
  testbox core/computers' own test files + dockerproxy: 277/277 pass, 9 skipped. Sent to the
  reviewer. Not yet done: wiring memberTokenKey to the real vault (module.json's needs.vault,
  the same shape tailnet.key already uses) -- pool.js takes it injected, faked in tests today.
- Both reviewer LOWs plus the person-only tools and vault wiring (1c5c257e), the gate for this
  sha per the lead: LOW 1 -- computers_agent_generations, a ledger that survives removal, so
  bumpGeneration() never hands out a used generation again; addAgent bumps it on every add, a new
  rotateAgent bumps it explicitly without touching membership. LOW 2 -- addAgent refuses (before
  touching anything, including making the row) an agent already on a DIFFERENT shared computer.
  computers.member.add/.remove/.rotate/.dispose are all PERSON_ONLY now, and memberTokenKey goes
  to the real vault (MEMBER_TOKEN_ITEM = "vyre-shared-computer-member-key", module.json's
  needs.vault, fetched fresh every time, never auto-generated -- a person vault.puts it first, the
  same as tailnet's own key). Tests: pool.test.js 40/40 (5 new), computers.test.js +2. Live-
  verified on testbox against the real stack: rotation invalidates the old derived token and
  validates the new one at once; the cross-computer refusal leaves no trace of the second
  computer at all. Stack torn down after. testbox core/computers/presence/docs suites: 380/380
  pass, 10 skipped. Also fixed in this pass: docs/work/glass.md itself had a literal double-star
  glob marker (several test-glob mentions) that test/docs-build.test.js's own render check flags
  anywhere in the output -- it had been silently failing since roughly 3f03ddb0's own doc update;
  reworded, docs:ref regenerated, all 61 docs tests pass now.
- Reviewer SIGNED OFF 1c5c257e (testbox: pool, computers, computerd index, boundaries -- 92/92),
  with two more LOWs. Both fixed at f4ea6ff1: LOW 1 -- disposeContext now refuses an agent still on
  the computer (remove first), since disposing a live member would hand its own client a fresh
  context mid-session. LOW 2 -- a failed addAgent (missing vault key, computerd unreachable) no
  longer leaves a stray member row or a freshly-made computer row behind; a brand-new member's row
  is deleted on failure, an already-existing member's prior name and generation are restored
  instead (checked for BEFORE the insert, not after, so the two cases are told apart). The
  generation ledger's own bump is never rolled back, by design. Tests: pool.test.js +4,
  computers.test.js's vault-failure test updated to match (its old assertion was exactly LOW 2).
  Then merged main (6bcd0385, the personguard PERSON_ONLY security hotfix) -- clean except the
  generated docs files, regenerated with docs:ref. Re-ran presence + docs-* + this module's own
  suite per the reviewer's merge note: green. Reviewer signed f4ea6ff1 + the merge off, with one
  more LOW: rolling a fresh member back by deleting its computer row could orphan a real container
  ensure() already created (even started) for it, since nothing in computers_computers would ever
  name it again for freeze/sweep/reconcile to find. Fixed: the same catch now stops and removes
  that container (best-effort -- a driver already gone or already stopped never blocks the row's
  own cleanup) before the row goes, so "no trace" covers the driver's own state too. Tests:
  pool.test.js +1, plus the existing fresh-member test now checks the container is gone, not just
  the rows. 187/187 local.
- Idle hand-back after 5 minutes, the 4-viewer cap, relay backpressure, dropping SetDesktopSize
  and xvp, clipboard to the holder only while shielded (computers).
- Vault remote fill; the private sign-in from the Deck checked live.
- Chrome's `--no-sandbox` bar and the restore-pages bubble in the image.

## Needs from others

- computers: the relay and image fixes in ADR 0005 decision 1; `computers.shield`;
  `computers.helper`; accept the computerd `/fs` routes.
- security: `computers.takeover` and `computers.giveback` on the human-only list.
- vault: the remote fill route (an addendum to ADR 0010).
- link: keep the denied-path list equal to `core/glass/guard.js`; a `mac` target later.
- capsule: an "Open Glass" action for threads whose agent has a computer.
- deck: the `/glass/:target` route (the loader is already there).
- box: run the stack with a computers container labelled `run.vyre.glass*` for the live check.
