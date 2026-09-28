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
  `kind: "fill"` untouched. Tests: cdpmux.test.js 25/25 (8 new); testbox `core/computers/**/*.test.js`
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
  cdpmux.test.js 32/32 (7 new); testbox core/computers/**/*.test.js 229/229 pass, 9 skipped. Still
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
  index.test.js 12/12 (6 new); testbox core/computers/**/*.test.js 234/234 pass, 9 skipped. Sent to
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
  Tests: cdpmux.test.js 35/35 (3 new); testbox core/computers/**/*.test.js 237/237 pass, 9 skipped.
  ba1f766d (identity) is SIGNED OFF by the reviewer and may land. Still gating the browser kind:
  .agent-tokens' own permissions (0400 vyre, archive-API, tested), revocation (reload the map and
  close live clients, or restart, when an agent is dropped), and the shield's shared-mode semantics
  (undecided -- does it lock every agent while one signs in).
- Presence enforced once security merges; a passkey step in the Deck.
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
