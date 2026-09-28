# tailnet

Branch: work/tailnet · Worktree: ../vyre-tailnet · Decisions: [ADR 0014](../adr/0014-tailnet.md)

## Scope

Use Tailscale fully wherever Vyre already relies on it, and wire each feature into the area it
helps. All ten parts of ADR 0014 are built. Each ships off, turns on with one switch, and changes
nothing on the tailnet itself: every ACL, nodeAttr, grant, key, Lock and Funnel step is the user's,
written out under "Steps for the user".

## Done

Round 1 (parts 1 to 6):
- Health: `link.health` (edeb4b8); Glass paces relayed viewers (e525741); Deck and Capsule show it (e0df7c1).
- Taildrop: `files.send`, `vyre send`, the box inbox (849bd4d, 03902bd, 8274e88, d3faa49).
- Taildrive: shares, audit, Mac mount, `/work` read-only in tailscaled (41ae09c, 8b75853, 0021b94).
- Tailscale SSH first in `vyre box add` and `move` (05f3ba9).
- Tailnet Lock read, onboarding card, Settings row (ff5111c, fc30220).
- Glass egress through the Mac (7f2519b, 8502ce4, 0097f64, 273b30b).

Egress fixes from the e2e run (27 Sep 2026):
- Fail closed in every case: `core/computers/egressgate.js`, a SOCKS5 gate in front of the
  sidecar that refuses (REP 0x02) unless the sidecar's tailscaled shows the Mac in use as the exit
  node; `computers.egress.status` shows its verdict as `gate`. A key that survives restarts: OAuth
  client secret or reusable ephemeral key, with `--advertise-tags=tag:vyre-egress` (62ebce3).
  Test box: 63 of 63 on
  `core/computers/egressgate.test.js core/computers/egress.test.js core/computers/computers.test.js
  core/computers/pool.test.js test/hygiene.test.js` (the gate's own file 12 of 12), and
  `docker compose -f box/compose.yml -f box/compose.egress.yml --profile computers config` passes
  with dummy values.

Round 2 (parts 7 to 10 and integration):
- One whois parser with tags and app capabilities (9ddba0f).
- Caller classes owner, guest, agent node in the names listener (526dc43); the router limits
  guests and still requires an agent node's key (7e8859e); the `network` module's guest tools (c283d47).
- Vault: `vault.relay.grants` and `vault.grants.status` (0622c88).
- Agent nodes: config (6a58845), the computer's tailnet side (e276166), join and leave in the pool
  (daf3fd7), tools (7757830), the key only to a driver-named tailnet port (020163c). Not live
  until the image change (Decisions needed 4).
- Webhooks: watchers on events with payload filters (0fa5931), the `hooks` module (7dd4a68),
  `vyre hooks` (32b3239).
- Surfaces: one Deck health helper and dots in Chat and Glass (b2af31e), Settings Network rows
  for shares, webhooks, guests, agent nodes and egress (011e0b8), onboarding HTTPS step then Lock
  (53c78d0), Capsule send on option-return and a health dot (ec1543a).
- Presence: the new owner actions on the floor's human-only list (8cb5c6d).

Tests: each branch was green on its own targeted files before merge (round 1: 258 of 258 on the
merged branch; round 2: guests 194 + 26, vault 52, agent nodes 145, hooks 66, surfaces 209 with 6
skipped).

Merged round 2, verified on the test box (27 Sep 2026, after merging main at bfbfd69 and the surfaces WIP
2fdbae9), `nice -n 15`, Node 22.23:
- The targeted run under "Doing": 803 tests, 785 pass, 12 skipped, 6 failed. One was ours
  and is fixed: the computerd tailnet "any uid but root" test used uid 1000, which is the test box's
  runner, whom the test treats as root; it now picks a uid that cannot collide (computerd: 11 of
  11). The other five fail the same way on main on the test box, so they are not this branch's (listed
  for the integrator under "Needs from others").
- Deck and fixtures (surfaces WIP): `test/fixtures.test.js deck/test/*.test.js deck/js/*.test.js`,
  35 of 35. `deck/views/settings.js` has no unit test; it passes `node --check`, and the three
  fixtures it reads parse.

Perf (scripts/perf-check on the test box, 20,016 turns, 23 modules, host load 4.4 to 5.1): CPU p95 0.00%,
sustained 0.00%, mean 0.00%; RSS mean 94 to 107 MB, max 140 to 145 MB (budget 150; main measured
147 MB max the same day); no recurring timer under 60 s. Before the fix below, the sustained CPU
check failed at 13% on this branch: one CPU-second at +1.5 s into the idle window, which a CPU
profile and a trace of Memory's pass showed to be the tail of startup curation (3.6 s on 20,000
turns) running past perf-check's 250 ms settle, not idle work. perf-check now waits for
`memory.curate`, which answers once that pass is done, before it starts the idle window.

Taildrive per-share access and the secrets scan (ea158df, 27 Sep 2026):
- Per-share access: `files.drive.shares` entries are a path or `{ path, access }` (a path is
  read-only, or the old global `files.drive.access`); status rows carry `access`; the Mac mounts
  each share by its own access. Tool `files.drive.access { name, mode }`, owner only, on
  HUMAN_ONLY, saves the access and answers the mount step.
- The compose mount stays read-only unless some share is rw; `files.drive.access` answers
  `Set VYRE_DRIVE_ACCESS=rw in /srv/vyre/.env, then run docker compose up -d` (or back to ro).
  The compose comment says so.
- A share refuses a folder with a secret anywhere inside (`unsafe_share`, `detail.found` up to
  10 paths; over 20,000 entries is too big to check); `files.drive.audit` rescans shared
  folders into `unsafe`, also in `drive.exposed`.
- Test box, `nice -n 15`, after merging main at 6e205a9: core/files/drive.test.js 21 of 21,
  core/files/files.test.js 18 of 18, core/presence/presence.test.js 22 of 22,
  test/hygiene.test.js 1 of 1, test/docs-build.test.js 31 of 31, test/fixtures.test.js 1 of 1;
  `gen-docs-reference --check` fresh.

## Doing

28 Sep 2026, still later, two items from the lead: relay.join refuses on darwin, and the host
sanitised the same way as the name. `relayJoinRefusal(platform)` (exported, a pure function of an
explicit platform like installCommand/operator in core/names/tailscale.js) refuses with
`not_available_here` on darwin: redeeming a pairing code persists this device's own identity key
(relay-device/key.json, core/relay/redeem.js) at the person's login uid, the same gap that already
keeps relay hosting off by default on local role until vyre-core (ADR 0040) holds the box's own
relay key instead. Wired into relay.join's run() (refuses first, before owner()) and into
presence.when (no Touch ID prompt on darwin: the call can only fail). Host sanitisation: pulled
the name's existing strip-and-cap into a shared `promptSafe` helper, widened the stripped set to
Unicode format and bidi characters (zero-width, RTL/LTR override and embedding, BOM — none of
which parsePairUrl's own check on `relay` bars, since it only refuses whitespace and a slash) and
applied it to the relay host too, capped at 64 (hosts run longer than names). Tests (testbox):
relay.test.js 18/18 (2 new: relayJoinRefusal direct plus an end-to-end darwin run via
Object.defineProperty(process, "platform", ...) before starting a fresh daemon — the module reads
platform once at its own start(), so the flip has to happen first, not after; and the hostile-host
case folded into the existing hostile-name prompt test), boundaries+hygiene 8/8, docs-build+
docs-index 37/37 (the description change moved docs/reference/tools.md; regenerated with
npm run docs:ref and the committed-index test still passes). Sent to the reviewer.

28 Sep 2026, right after: reviewer SIGNED OFF 7f9bc201, one nit — promptSafe's stripped set was
missing two separator characters that are neither a C0/C1 control nor in the zero-width/bidi
blocks: the Arabic letter mark (U+061C) and the Mongolian vowel separator (U+180E). Added both
(86e491ba), extended the hostile-host test to cover them. Testbox: relay.test.js 18/18. Idle.

28 Sep 2026, latest of all: reviewer signed off ad8f560c/98ddb0a8/0a77983c/6cd9c02d (relay.join,
in full). Reviewed anywhere's onboard guard (work/anywhere 6300ecaf) properly, found a real bug of
my own while doing it: onboard.machine's shipped input is `{machine}`, no "action" field, but their
own design doc still says `{action:"set", machine}` — both my becomeDevice call sites were built
against the doc, fixed to match the code (b23036af), flagged the doc drift to anywhere. Fixed
reviewer's LOW on relay.join's prompt too (97a17392): offer.name (the OTHER box's own chosen text)
is stripped of control characters/newlines and capped at 40 characters before it's quoted, and the
trailing key fingerprint is always computed here from the real key, never from the name — a
hostile box can no longer write a fake "(key ...)" trailer into its own pairing offer. Sent
anywhere a coordination note: if they narrow onboard.machine's callers off bare "module", they
need to include module:relay specifically, or relay.join's becomeDevice breaks silently (my
ctx.call(...).catch(()=>{}) swallows the resulting error). launch has wired both paths
(relay.join{url,becomeDevice} and onboard.join{verify,node,becomeDevice}) on fixtures, waiting on
both to land on main. Testbox: 51/51.

28 Sep 2026, latest still: fixed reviewer's MEDIUM on relay.join before the stay-connected
follow-up (6cd9c02d). The Touch ID prompt was generic ("Pair this device with another Vyre");
now it parses the URL and names the actual box, its relay host, and a short key fingerprint
(base32 of sha256 of the box's public key, 8 chars as two groups of 4), so a phishing message's
pairing link can't blend in as "just pairing", and a url that fails to parse gets an honest
summary instead of a silent generic fallback. Refuses before any prompt at the schema layer
(checkInput runs before presence.required) for anything not shaped like a pairing link, and again
in run() via parsePairUrl for a well-formed-looking but corrupt fragment. Testbox: 54/54.

Standing by per the lead: review anywhere's shared onboarding-on-Mac check (setup tools refused on
a Mac unless Solo genuinely needs one, 127.0.0.1:7300 only on a server) when it lands — that's
reviewer's condition 2, still open, and not mine to build a second version of. Idle otherwise.

28 Sep 2026, latest: two more items from the lead. First, extracted relay's key access into
`core/relay/keys.js` (3ab44de2) — loadKeys(root) unchanged in behavior, just its own file, so
moving where the box's Noise/route keys live (vyre-core's `_vyre` service user, ADR 0040) is a
swap of this one file, never a rewrite of relay's pairing logic. Second, and bigger: built
`relay.join` (93754fa2), the redemption side reviewer wanted to see — a fresh Vyre install
becoming a device of another box, over the relay, with a one-time pairing code. New
`relay/client/nodecrypto.js`: a Node-native CryptoProvider for `relay/client/*` (the SAME
cross-platform library the Expo app uses, so this is not a second protocol implementation), since
Node's own `globalThis.crypto.subtle` makes non-extractable keys that cannot survive a CLI's next
process, and `@noble` is the Expo app's own dependency, never this repo's. New `core/relay/redeem.js`
(a plain function) and the tool `relay.join`: takes a pairing URL, runs the handshake, persists this
device's key so its identity survives a restart, refuses guest/agent/hook/anonymous the same as
relay's own owner(). Does not keep a connection open afterward — that is `connect()`'s job, not
built yet. Tested end to end: two real daemons, a real local relay server, the box mints a code
with `relay.pair.first`, the device redeems it with `relay.join`, the box's own device list shows
it, a second redemption from the same root reuses the same device id. Testbox: 59/59.

28 Sep 2026, still later still: reviewer OK'd the Solo-join shape with 4 conditions; anywhere OK'd
widening relay's roles (theirs is landing onboard's own roles change separately). Built (2a02f4d8):
relay/module.json roles -> `["box","local"]`, no code change (audited start(): startLink() only
fires when settings().enabled, default false; no timers anywhere in the module); new
test/relay.test.js proving it — boots role local with default config, zero relay.connected/
disconnected events, no injected WebSocket seam (so it is the real globalThis.WebSocket path
proven untouched). onboard.join's tailscale-connect step now calls `tailscaleUp()` directly
instead of `ctx.call("names.connect")`, dropping the box-only `names` module as a dependency for
that path; onboard.tailscale itself unchanged.

**Not shipping**: relay-on-a-Mac stays built-but-disabled until vyre-core (ADR 0040, e2e +
anywhere) holds relay's pairing secret and trusted-device rows. Today those sit in
`~/.vyre/vyre.db`, readable and writable by any process at the person's uid — a prompt-injected
model could read a live pairing secret or insert its own device row for lasting access. Reviewer's
condition 3, and already on vyre-core's list. Do not enable relay by default on local role in any
release before that lands.

**Open**: reviewer's condition 2 (audit onboard's start() for local-role side effects beyond the
9 wizard tools) is on hold — asked anywhere whether their own onboard roles change keeps my
"guard the 9 wizard tools" idea, since their Solo-onboarding design might legitimately want those
tools live on local by intent, which would make my assumption wrong. Waiting before writing a test
that could assert the wrong thing. Settled with launch (not yet confirmed back by them): "I already
have a server" splits into a no-code Tailscale path (`onboard.join{tailscale,connect}` then
`{verify,becomeDevice:true}`) and a relay path whose code is minted by `onboard.join{action:"relay"}`
but redeemed by `relay/client/*`, not by any join.* action.

28 Sep 2026, still later: reviewer signed off bac69fa8 (owner-only onboard.join, confirmed by
merging in e2e-personguard c3a69611 via origin/main and running test/person-only-guard.test.js —
onboard.join's callers list derives PERSON_ONLY automatically). Root-caused (not just flagged)
the testbox onboard.test.js failure I'd been calling "pre-existing": bundled this branch, checked
out ecd89c0c (the commit that introduced the failing test, well before anything in today's
session) on testbox, ran it alone — failed there too, proving it was never caused by join work.
Cause: operator() (core/names/tailscale.js) skips its check entirely on darwin, so a missing
OperatorUser field in the test's fake tailscale script passed by accident on every Mac and failed
for real on testbox's Linux, the only place the check runs. Fixed (dd1c3765); test/onboard.test.js
is 23/23 on testbox now. All testing from here on is testbox only, per the lead.

Answered launch's shape question: "I already have a server" splits into two paths that don't
share a mechanism — Tailscale (no code: `onboard.join{tailscale,connect}` then
`{verify,node,becomeDevice:true}`, needs nothing new) and relay (the code IS a pairing secret, but
minted server-side by `onboard.join{action:"relay"}` and redeemed by the relay CLIENT protocol,
`relay/client/*` — not a join.* action, and not mine to build).

Sent e2e a question on the Solo-join design before continuing: the lead flagged that pairing/relay
keys move into vyre-core (a new `_vyre` service user, ADR 0040, e2e + anywhere) on a Mac, and
wants the join design to go through that boundary. Waiting on ADR 0040's shape (or e2e's direct
answer) before writing the relay/onboard "local" role code my design note (sent to reviewer and
anywhere, still unanswered) proposed.

28 Sep 2026, later still: built `onboard.join` as `core/join` (the lead: "stop waiting, build it").
join.status/join.tailscale/join.relay/join.verify, box role, all thin forwards through ctx.call
to onboard/relay/link's own tested tools (see "Changed contracts"). Works today for pairing a
second device to a box, and for a moved installation pointing back at its server. Does NOT yet
cover the lead's other example, a phone joining a Solo Mac: role "local" has neither onboard nor
relay loaded (both `roles: ["box"]`), so there is nothing for `join` to forward to there. That is
not mine to fix alone — flagged below. Sent af604cf8 to reviewer. Answered launch: Solo needs
nothing from this module (confirmed), names.discover is unaffected by anything here (it scans
peers and hits the already-shipped GET /v1/whoami itself, a client-side tool still to build, not
a change to /v1/whoami).

Same day, right after: launch asked for one tool with an action/step param instead of four (to
match onboard.name/claude/tailscale's own shape), and anywhere OK'd the design and asked verify to
call their new `onboard.machine` once reachability is confirmed (ADR 0039 section 5, contract in
their docs/design/anywhere.md; not yet on this branch). Dropped `core/join` entirely (5807096d);
`onboard.join` now lives in core/onboard/index.js, one tool, reusing onboard.tailscale's own
functions directly (no self-ctx.call) for the tailscale action. `becomeDevice` is an explicit
opt-in flag on verify, defaulting false — my call, not yet confirmed by anywhere/launch: verify
runs on both the connecting device and (potentially) the solo/server side checking a peer, and
only the connecting side should ever demote itself to "device". Tests: test/onboard.test.js
22/22 (6 new). No regressions: boundaries/hygiene/module-sdk/modules 48/48 (this Mac only —
testbox is frozen for the integrator's rc.2 canonical suite; will sync and run there once it
lifts). The box-role-only gap (a phone joining a Solo Mac) is unchanged by this refactor; still
flagged below and to relay/anywhere/launch.

28 Sep 2026, later: new top priority from the user's "Vyre anywhere" decision (see
team/HANDOFF.md) — Tailscale is not needed for Solo; it comes in only when a second device or a
server joins. My part: the "join" flow (guide Tailscale setup or offer the relay alternative,
pair, verify reachability), simple, one-paste policy tool, never `tailscale up` or an ACL edit
myself. Committed prior WIP first: core/vitals module (0.1.0, five tools, person-only, 33/33
tests), 6a52ad23. Proposed the join interface to anywhere, launch and federation (not yet built,
awaiting their OK): a new box tool `onboard.join` (HUMAN_ONLY), separate from the first-run
wizard — `status` (tailscale + relay availability), `tailscale` with `step: policy|connect|lock`
(delegates to today's onboard.tailscale logic), `relay` (delegates to relay.pair.start),
`verify` (link.health, answers reachability + which path). Waiting on their answers before
building `onboard.join` itself.

Built meanwhile, the join flow's lowest primitive: `GET /v1/whoami` on the tailnet listener
(core/names/service.js), for a device that thinks it just reached the box over Tailscale (or,
later, the relay) to confirm it as owner or guest before the join UI goes further. Minimal by
design: `{ kind, name }`, name only for the owner, never a login/tag/cap (those already reach the
router via callerOf/peer for tools that need them). Refuses an agent's node outright (`403`, a
computer has no join flow of its own) and rate-limits at 10/minute per node/stableId (`429`), since
it needs no proof beyond whois. Tests: core/names/service.test.js 18/18 (4 new), plus
test/boundaries.test.js, test/hygiene.test.js, test/guests.test.js, test/link-federation.test.js
24/24 (no regressions). Next: wire `onboard.join.verify` (once agreed) to call it for the joining
device's own reachability check, not just the box's.

Also built: `vyre vitals` (status/explain/advice), vitals' first CLI surface (module.json
`shows.cli` was empty). core/cli/commands/vitals.js on the standard pattern; tips now point at it
instead of `vyre call`. Tests: core/cli/commands/vitals.test.js 2/2, consistency 9/9. Testbox
83/83 across vitals, the new test, consistency, docs-build, hygiene, boundaries (a3f73860).

28 Sep 2026 (resumed; merged origin/main a3a844e4 into work/tailnet, clean). Wrote
docs/design/tailscale-plan.md for the lead's max-benefit/simplest-install ask: verified all ten
ADR 0014 parts by content against origin/main (nine are ancestors of main; part 9, agent nodes,
is not wired — core/computers/image/Dockerfile still runs everything as `USER agent`, no
root-then-setpriv step). Lead's decisions back: part 9 ships in 0.1.1 on top of glass-live's
root-then-setpriv image change once that merges (messaged glass to coordinate: my side, join()
in core/computers/tailnet.js, already degrades safely on a 404 and needs only the real port
number/how the root process starts once their image lands); the merged-policy-snippet tool ships
0.1.1 (with launch, in onboarding); device posture is skipped. Built: `onboard.tailscale
{ action: "policy" }` in core/onboard/index.js — merges Taildrive's nodeAttrs/grant, Taildrop's
grant and the SSH rule into one paste using real names this machine already knows (its own
tailnet node, the paired Mac from `link.peers`, the owner's login, the shares from
`files.drive.status`), adding egress's tagOwners/grant only while `computers.egress.status` says
it is on. Read-only, no tailnet write (ADR 0014 rule 1). Tests (targeted, this session):
test/onboard.test.js 17/17 (2 new), test/boundaries.test.js 5/5 (no new import: uses ctx.call,
not a direct import of files/drive.js or computers/index.js), test/hygiene.test.js +
test/docs-build.test.js 39/39. MagicDNS surfacing (the other 0.1.1 item) is already done —
`t.node.dns` is the primary line in both deck/onboard/onboard.js:430 and
deck/views/settings.js:277, and `vyre box add` already prefers a peer's dnsName
(core/cli/commands/box.js:273) — nothing to build there. Next: message launch about wiring
`onboard.tailscale{action:"policy"}` into the onboarding UI (a "copy policy" panel, likely near
the tailscale step or in Settings, Network); wait on glass for part 9's port number.

27 Sep 2026 (resumed after logout 3, main ef51363 merged at 7036361). Done this session:

- 1498c4a VyreDrive: users see the box shares as "VyreDrive (built on Tailscale's Taildrive)"
  (tool descriptions, refusals, the Deck row, compose comment, docs; the anchor is now
  `#vyredrive-the-box-folders-on-your-mac`). "Taildrive" stays only where it names Tailscale's
  mechanism (drive:share, drive:access, tailscale.com/cap/drive, their docs link, "in alpha").
  The share scan skips real node_modules, dist, .next, target, venv, .venv and .git/objects (not
  counted toward SCAN_LIMIT) and flags a .git/config with a URL carrying user:pass or a token
  before the host, or an extraheader with Authorization (an ssh URL with only a login name is not
  a finding). files.drive.access moved HUMAN_ONLY to PERSON_ONLY. GUEST_SAFE is glass.close and
  threads.list (glass.open dropped).
- 387c671 CORS for the hosted app (`network.origins`, default `https://app.vyre.run`, exact
  match) on the tailnet listener: owner only (a guest or agent node gets a plain 403 with no CORS
  headers), preflight GET/POST with content-type, authorization, x-vyre-session, max-age 600, no
  credentials, `Access-Control-Allow-Private-Network` when asked. `GET /v1/health` from the app
  answers `{ reachable: true }` without vyred (the tailnet probe). Every other call and WebSocket
  needs `deps.webSession(req, who)` (e2e fills it; none wired yet, so all refused with 401
  `web_session_required`); the router gets `peer.origin` and `peer.webSession`.
- 32cef89 (+ f094246) projectsDir: a box with /work and no projectsDir set uses /work/projects;
  the first start moves homes from ~/Vyre/projects once (EXDEV copy across volumes), leaves a
  link at each old folder (Claude transcripts are keyed by path), rewrites rows and markers,
  records projects-moved.json and emits projects.moved. Docs updated.

Tests (test box, `nice -n 15`): the subagent's runs 241 of 242 (1 skipped) and 67 of 67 over
drive, files, presence, guests, identity, hygiene, docs-build, fixtures, presence-bypass,
presence-cli, harness, capsule launcher, deck/test, docs-check, docs-index, computers, glass,
move; then 100 of 100 (service, identity, guests, onboard, hygiene, docs-build, config, move) and
106 of 106 (projects, config, drive, docs-build, docs-check, docs-index, hygiene). A mutation
check (owner and session rules removed) fails the CORS test. No perf change expected (no timers,
one header check per request); perf-check not rerun.

Phone path, tailscale#19147 (researched 27 Sep, no device): OPEN since 2026-03-27, iOS 26.4.x.
Safari/Chrome show ERR_SSL_PROTOCOL_ERROR or "server not found" on *.ts.net while the 100.x
address works. Not TLS: a DoH app or encrypted-DNS profile (DNSecure, NextDNS, Control D)
overrides Tailscale's split resolver on iOS, so the name resolves publicly (to Funnel ingress when
Funnel is on, hence the TLS-looking error) or not at all. Private Relay and Limit IP Tracking are
not the cause. Related open iOS issues: #18889 and #19504 (tunnel drops every few minutes on iOS
26.4, app 1.94 to 1.96.5), #13799 (On Demand does not trigger for ts.net names). Nothing on the Mac
or in the Simulator can reproduce it (they use macOS's stack); only the server side can be
checked (`openssl s_client ... -alpn h2,http/1.1`, `dig +short <box>.ts.net @1.1.1.1` must be
empty). Risk: medium-high as the only phone path. Mitigations: keep Funnel off on the box (clean
"not found" instead of a fake TLS error); the hosted app at app.vyre.run probes
`https://<box>/v1/health` (built, above) and falls back to the relay, with help text naming the
cause (Tailscale off, a DNS app, toggle Tailscale); a service worker on the ts.net origin shows a
cached help page. Recommendation to the lead and app-design: relay as the always-works path and
the tailnet as an automatic upgrade when the probe answers. The docs row is in
docs/using/tailscale.md "When a device cannot connect".

Later the same day (lead and e2e answers):
- 1afde745 e2e's contract: CORS headers are content-type, authorization, x-vyre-proof (not
  x-vyre-session, the socket's thread header). The listener no longer checks sessions: it passes
  `req` untouched with `peer.origin`; the router (core/daemon/index.js route()) refuses any
  cross-origin call without a person session, `401 person_session_required`, except
  `POST /v1/person/token`. The seam is `core/presence/person.js` `personSessions(db).sessionOf`
  (a stub that finds none; e2e wires it; `start({ person })` injects one in tests). WebSockets
  from the hosted origin pass for the owner (tickets already need the session). GUEST_SAFE is
  threads.list only. `projects.move` is PERSON_ONLY. Test box: 285 tests, 284 pass, 1 skipped.
- 75d21113 projects: no automatic move. A new box uses /work/projects; an existing one keeps
  ~/Vyre/projects until `projects.move` (`vyre projects move --dry-run` first). The real move
  needs VYRE_PROJECTS_MOVE=1 or config projects.move "enabled": box-deploy validates it on a
  copy of the live box first.
- Lead decisions: a login-only ssh remote is not a secret; relay is the always-works phone path
  and the tailnet an automatic upgrade when the probe answers.

- 7cd25e6c: e2e built the gate in the router themselves (work/e2e 8ad92a73, fb097a3d), so my
  stub core/presence/person.js and my route() gate are removed; the listener only sets
  peer.origin and passes req untouched. Trial merge with work/e2e conflicts only in generated
  docs, CHANGELOG, core/presence/index.js (PERSON_ONLY: take both lists) and
  test/guests.test.js (take mine: guests have threads.list only). NOT yet tested: the test box is
  frozen for the integrator's suite. Queued run: core/names/service.test.js test/guests.test.js
  test/daemon.test.js core/presence/presence.test.js test/hygiene.test.js test/docs-build.test.js.

- Relay (27 Sep): the only origin is https://app.vyre.run (no previews). The relay path needs no
  CORS (one WebSocket to relay.vyre.run, requests rebuilt in-process by bridge.js with caller
  device:<id> and no Origin), so this CORS serves only the direct tailnet path. Its allowed
  headers now match the relay's: content-type, authorization, x-vyre-proof, x-vyre-presence,
  idempotency-key, last-event-id.

- After the freeze (test box, `nice -n 15`, load 4.5): names service, identity, guests, onboard,
  daemon, presence, presence-bypass, projects, config, hygiene, docs-build, docs-index, fixtures:
  179 tests, 178 pass. The one failure was my hosted-app test asserting e2e's 401, which lives on
  work/e2e; it now asserts only the listener's part (guests 9 of 9).

- Final state (27 Sep, stop point): work/tailnet a7365a99 (main merged at e785f124, system.info
  answers network.origins for pwa's Hosted app row; test box 154 of 154). work/federation
  334270d1 on top of 06441c6f: Mac-owned asks answered from the box, an owner device needs the
  person session, gated asks need a fresh proof, the Mac rechecks (test box 252 of 252). Both
  pushed and queued for merge batch 4 (after 3a). The Mac-owned session default stays HELD until
  e2e's person session is live on the box. Follow-ups sent, each pointing at
  docs/work/federation.md "Needs from others": chat (Deck buttons in place of "Answer it on
  <mac>"), pwa (push for a Mac ask opens /needs/<ask>, which the box cannot load), sessions
  (review the switchboard hunks; threads.asks on the box does not list open Mac asks). Side
  effect for sessions: on a box /v1/tools lists threads.answer with presence: true.
- Sessions reviewed 06441c6f and 334270d1: fine, applies cleanly after batch 3a. Sessions
  DECIDED: threads.asks on the box merges the Macs' open asks (add "threads.asks" to ALLOW in
  core/link/allow.js, rows labelled source:"mac" and machine via mergeRows, as threads.list does
  in core/switchboard/index.js). Built: work/federation 98048454 (test box 117 of 117), sent to the integrator for batch 4. Chat's Deck side is
  work/chat b524397 (untested; told them no flag is needed and that a passkey proof is not a
  person session).
- Next for whoever resumes: box-deploy's validation of `projects.move` on a copy; the "Verify on
  first real run" list below; the egress authenticating front (Next 4).

Waiting: e2e (merges work/tailnet and tests the app flow end to end), relay (origin list, and whether the
hosted app ever reaches the box through the relay), sessions (threads.answer contract for
Mac-owned sessions, below).

## Next

Order (lead, 27 Sep 2026): the WebSocket upgrade handler (above), then the Mac-session send
path's loose ends (below), then Taildrive.

- Mac-session send, loose ends (work/federation):
  - Fix the phone /find page: no machine chip on Mac rows (lead's item 3).
  - Chat asks that the Mac's rows in threads.list and projects.catalog carry `source: "mac"`,
    as main does. Check the labels survive on the paths chat reads, then send chat the frozen sha.
  - ADR 0021: record v2 of threads.answer on a Mac session. The box verifies presence, then
    sends a signed assertion from the paired box, which the Mac accepts for threads.answer
    only. v1 ships the Deck line "Answer it on <mac>" (lead's decision).
  - capsule-now has not answered the queue-flow review yet.
  - projects.list does not count a picked Mac session in a project's thread count (Chat shows
    "1 session" where the board has 2).

The lead's earlier decisions of 27 Sep 2026, still to build in this order:

1. Done: **link.health on the box: modules and the owner only.** `core/link/box.js` refuses
   guests, agent nodes, agents at the box, MCP, anonymous callers and any tailnet login that is not
   `network.owner`; test in test/link.test.js. Tests on the test box: link, link-federation,
   guests, health, glass, hygiene 33/33.
2. **Taildrive:** done (projectsDir move 32cef89, under "Doing"). Verify on the first real
   box start: the move across the vyre-home and vyre-work volumes, and Claude resuming a
   session through the old-path link.

0. **Done on work/federation 06441c6f (see docs/work/federation.md). Federation, threads.answer for Mac-owned sessions** (ADR 0030 step 7, ADR 0021 v2),
   proposed to sessions 27 Sep: the box checks a person caller, then forwards over the link with
   an Ed25519 assertion { v, tool, mac, thread, ask, decision sha256, caller, device, iat, exp
   +60 s, nonce } signed by a box link key the Mac pins at pairing (TOFU once for paired Macs).
   The Mac accepts it for threads.answer on that ask only, once. Build on work/federation after
   sessions confirms the ask id, the input shape, the already-answered outcome, and source:"mac"
   on relayed ask events.
3. **Taildrop:** the box stays a tagged server. The user step is the file-sharing grant to the
   box's tag (already under "Steps for the user"). Drop the "sign in as the owner" alternative.
4. **Egress:**
   - Done: renew with a Tailscale OAuth client (`--advertise-tags=tag:vyre-egress` is set), and
     the gate that fails closed when the Mac stops offering its exit node. The authenticating
     front below can live in the same gate (`egressgate.js`) rather than a new service.
   - Only the computer that has egress turned on may use the proxy. Per-computer credentials,
     handed out like the other bootstrap secrets (not in container Env), plus a network policy
     if compose allows.
   - Known limit to report: tailscaled's SOCKS5 server has no authentication, and Chrome sends no
     SOCKS5 credentials. So the plan is a small authenticating front (an HTTP CONNECT proxy with
     per-computer Basic credentials) in front of the sidecar's SOCKS5, answered through
     hands-chrome's CDP (`Fetch.authRequired`), plus a source-address allowlist of
     egress-enabled computers kept by the pool.
   - Inside one computer, any process of the agent's user can still use that computer's
     credential, because it owns Chrome's process. The lock is per computer, not per program.
     Tell the lead before building if that limit is not acceptable.
5. **Part 9's image change** (tini as root, a root-only tailnet side on 7001 with its own token,
   `setpriv` down to uid 1000): waiting on the user; see Decisions needed.

### Verify on first real run

The lead runs these once the user signs the box into Tailscale during onboarding. Until then,
only read-only checks on the test box.

- **Taildrive:**
  - tailscaled serves a share as the `vyre` user.
  - `mount_webdav` works against 100.100.100.100:8080.
  - The shape of `tailscale.com/cap/drive` in whois `CapMap`.
  - The WebDAV path's tailnet segment.
- **Taildrop:** the `file get --verbose` line format on 1.102, `TaildropTarget` for the tagged
  box, and the file-sharing grant's exact form.
- **Health:** the peer-relay `ping` line.
- **Egress:** containerboot with `read_only` and `cap_drop: ALL`, in-memory state, an OAuth
  client secret as the key (with `--advertise-tags`), Chrome with a `data:` PAC over SOCKS5 (the
  computer image's Chromium, never headless-shell), and `docker compose config` on both files.
  The gate on a real tailnet:
  - containerboot puts the socket at `TS_SOCKET` in the `egress-sock` volume, and uid 1000 in
    the gate can open it through the read-only mount (tailscaled makes it 0666; a status read
    needs no operator).
  - The status fields: `BackendState`, `Peer[*].ExitNode`, `ExitNodeOption`, `Online`,
    `ExitNodeStatus.Online`, in each of the e2e cases: Mac serving (allowed, bytes on the Mac's
    tailscale0), Mac stops offering, route unapproved, Mac off the tailnet (all REP 0x02, the
    gate's log says why, `computers.egress.status` shows it).
  - The recovery: offering again is allowed within 2 s, with no restart.
  - A sidecar restart with an OAuth client secret and with a reusable key comes back; the gate
    refuses while it is down.
  - A long-lived connection when the Mac stops offering mid-way: expected to break, not to move
    to a direct route, since the flow lives in tailscaled's netstack. Unverified.
- **Grants:** a `vyre.run/cap/vault` or `vyre.run/cap/guest` grant appears in whois `CapMap`,
  including for a shared-in node from another tailnet.
- **Funnel:**
  - The flags `--bg --https=8443 --set-path=...` and `off`.
  - The `funnel status --json` fields.
  - The proxy strips the mount path.
  - Node attributes show in `Self.CapMap`.
- **Agent nodes** (after the image change): a computer joins as `tag:vyre-agent`, and whois maps
  it to its agent.
- **Tailscale SSH:** `vyre box add` to a host with Tailscale SSH on, including check mode.

## Needs from others

- RELEASE BLOCKER, all teams: relay's pairing secret and trusted-device rows live in
  `~/.vyre/vyre.db` on a Mac today, readable and writable by any process at the person's uid.
  Widened relay to role "local" (2a02f4d8) for the Solo-join design, but it must not ship enabled
  on local by default in any release until vyre-core (ADR 0040, e2e + anywhere) holds those keys
  and secrets. Reviewer's condition, already on vyre-core's list.
- anywhere: waiting on whether onboard's own roles:["box","local"] change (landing separately)
  keeps the 9 wizard tools (you/claude/name/history/skip/finish/passkey/link/tailscale) guarded to
  refuse on local, or intentionally leaves them live for Solo's own onboarding — settles whether
  reviewer's condition 2 (audit onboard's start() for local-role side effects) is mine to close.
- launch: RESOLVED, now that relay.join exists — sent the final shape: the Device card's setup
  code is `relay.join{url, name, becomeDevice:true}` (one call, no separate verify: pairing itself
  proves reachability); the Tailscale route is unchanged, `onboard.join{tailscale,connect}` then
  `{verify,node,becomeDevice:true}`. Waiting on launch to confirm they've wired one or both.
- launch: names.discover (peer scan + GET /v1/whoami, already shipped a20e5eb6) is still to build,
  on the client side that does the scanning; not blocked on anything of mine.
- chat (via the lead): merge work/tailnet (owner-only streams) and work/federation-transcript
  6731af9 (rich Mac transcripts; then boot a Mac session from `recall.transcript { source: "mac" }`
  in deck/chat/session.js).
- integrator: merge work/tailnet (this branch's tip) and work/federation 5c247ce.
- e2e: re-run the egress checks on headscale (the list under "Verify on first real run").
- e2e: merge work/tailnet and run the hosted-app flow end to end.
- box-deploy: validate `projects.move` on a copy of the live box (dry run, then the real move
  with VYRE_PROJECTS_MOVE=1, then a Claude session resuming through an old-path link).
- relay: the hosted app's origin list (preview origins?) and whether it ever reaches the box
  through the relay (then CORS must be answered there too).
- chat: replace "Answer it on <mac>" with normal buttons calling threads.answer with `machine` (work/federation 06441c6f, federation.md Needs from others).

- vault: see the tailnet entry in docs/work/vault.md "Needs from others".
- computers: review the Pacer (`glass.js`), the pool's egress remake and agent-node join, the
  `stable_id`/`node`/`egress` columns, and `entrypoint.sh`'s PAC check. Part 9 needs the image
  change in Decisions needed 4, which amends ADR 0009.
- watchers: review the new `on`/`where` event trigger and the `hook.delivery` hand-over.
- capsule: repackage to pick up option-return send, the dot and the Taildrive open.
- box: review the `/work` mount in the tailscale service and `box/compose.egress.yml`.
- integrator: the full suite on the merge. Five tests fail on main on the test box as well as here, so
  they are environment or main issues, not this branch's: `box add: sudo with a password adds the
  account to the docker group...` (core/cli/commands/box.test.js:300; the test box's user is already in
  the docker group), `install-box.sh: missing Docker is offered...` and `...without --yes and no
  terminal...` (core/names/system.test.js:279, 286; the test box has Docker), `daemon: the presence
  challenge route refuses what it cannot start` (test/daemon.test.js:320, 403 not 400), and
  `bypass: a Bash tool call that tries it is denied...` (test/presence-bypass.test.js:129, Node
  22's SQLite ExperimentalWarning lands in the JSON it parses).

## Standing rules (user, 27 Sep 2026)

- Vyre does not nag: the user runs on bypass permissions. Nothing the person, their own sessions
  or their assistant do to their own things prompts or asks for Touch ID. Agents add notes,
  reminders and todos freely.
- Touch ID only for pairing a new device, vault secrets, and sending, posting or paying to the
  outside world. One Touch ID covers about 30 minutes per device.
- Agents stay silently refused on person-only tools.

## Decisions needed from the user

1. Decided (lead, 27 Sep): Taildrive read-only by default with a per-share rw switch behind
   presence; shares refuse flagged folders; projectsDir moves to /work/projects. See Next 2.
2. Decided: grant file sharing to the box's tag. See Next 3.
3. Decided: sidecar kept, OAuth client for renewal, per-computer credentials. See Next 4 and its
   limit.
4. Agent nodes: the image change (tini as root, a root-only tailnet side on 7001 with its own
   token, `setpriv` down to uid 1000, which needs SETUID and SETGID at start), and whether that
   side proves itself before vyred sends the key.
5. Guests: allow `threads.get`; narrow `threads.list` for guests; keep the tools in the new
   `network` module or rename them.
6. Webhooks: keep dropping repeated bodies; per-route secret grants.
7. Decided: `link.health` on the box answers modules and the owner only. See Next 1.
8. Company tailnets: grants and guests trust whoever edits the policy; add an onboarding check
   that the owner alone edits it?

## Steps for the user

Sample names: the owner is alex@example.com, the Mac is `alex-mac` (100.64.0.7), the box is
`tag:vyre-box` (100.64.0.5, `vyre.tail0000.ts.net`). Replace them with the real ones. Merge each
snippet's keys into the one tailnet policy file in the admin console (Access controls).

### Taildrive (box folders on the Mac)

```json
{
  "tagOwners": { "tag:vyre-box": ["alex@example.com"] },
  "hosts": { "alex-mac": "100.64.0.7" },
  "nodeAttrs": [
    { "target": ["tag:vyre-box"], "attr": ["drive:share"] },
    { "target": ["alex@example.com"], "attr": ["drive:access"] }
  ],
  "grants": [
    { "src": ["alex-mac"], "dst": ["tag:vyre-box"],
      "app": { "tailscale.com/cap/drive": [{ "shares": ["projects", "glass-files"], "access": "ro" }] } }
  ]
}
```

Then on the box: `vyre call --tty files.drive.share '{"name":"projects"}'`, and
`vyre call files.drive.audit`. For writes from Finder: `"access": "rw"` in the grant,
`vyre call --tty files.drive.access '{"name":"projects","mode":"rw"}'`, then the step it answers:
`VYRE_DRIVE_ACCESS=rw` in `/srv/vyre/.env` and `docker compose up -d`. Remount on the Mac.

### Taildrop (files to the box)

Admin console, Settings: Send Files on. The box stays a tagged server, so grant file sharing to
its tag. The grant's exact form is checked on the first real run:

```json
{ "grants": [ { "src": ["autogroup:member"], "dst": ["tag:vyre-box"],
    "app": { "https://tailscale.com/cap/file-sharing-target": [{}] } } ] }
```

### Tailscale SSH (for `vyre box add`)

On the server, `tailscale up --ssh` (or `tailscale set --ssh`), with a policy SSH rule:

```json
{ "ssh": [ { "action": "accept", "src": ["alex@example.com"], "dst": ["tag:vyre-box"], "users": ["autogroup:nonroot"] } ] }
```

### HTTPS (a ts.net address)

Admin console, DNS, HTTPS Certificates, Enable HTTPS. Onboarding shows this step when
`tailscale cert` fails for this reason.

### Tailnet Lock (optional)

On the Mac: `tailscale lock` to read its key (`tlpub:...`); the box's key is on the onboarding
card and in Settings, Network. Then, on the Mac:
`tailscale lock init --gen-disablements 2 --gen-disablement-for-support <mac key> <box key>`.
Save both disablement secrets in the Vault.

### Glass egress through the Mac

1. On the Mac: Tailscale menu, Exit Node, Run as Exit Node.
2. Admin console: Machines, alex-mac, Edit route settings, Use as exit node. Settings, OAuth
   clients: Generate, scope Auth Keys (write), tag `tag:vyre-egress`. The client secret does not
   expire, so nothing needs renewing. A reusable, ephemeral, pre-approved auth key tagged
   `tag:vyre-egress` also works (it expires). Never a single-use key: the sidecar keeps its state
   in memory and logs in again on every restart, so a single-use key fails the first restart with
   "authkey already used" and the sidecar never comes back.
3. Policy:
   ```json
   {
     "tagOwners": { "tag:vyre-egress": ["alex@example.com"] },
     "grants": [ { "src": ["tag:vyre-egress"], "dst": ["autogroup:internet"], "ip": ["*"] } ]
   }
   ```
4. On the box, in `/srv/vyre/.env` (not `vyre.env`): `VYRE_EGRESS_AUTHKEY=tskey-client-...?ephemeral=true&preauthorized=true`,
   `VYRE_EGRESS_EXIT_NODE=alex-mac`, and `COMPOSE_FILE=box/compose.yml:box/compose.egress.yml`.
   (A reusable ephemeral key goes in the same variable as it is. Not a single-use key: see 2.)
   Then `docker compose up -d` and
   `vyre call --tty computers.egress.set '{"enabled":true,"sites":["portal.northwind.example"]}'`.
5. Check: `vyre call computers.egress.status`. Its `gate` says whether listed sites can go out now
   (`allowed`) and why not (`reason`, for example the Mac is not offering its exit node).
   `docker compose logs egress` shows each change once. Test the PAC with the computer image's
   Chromium only: chromedp/headless-shell ignores every PAC, `data:` or http.

### Vault passes authorized by the policy (grants)

The holder dana@northwind.example reaches the box through machine sharing:

```json
{ "grants": [ { "src": ["dana@northwind.example"], "dst": ["tag:vyre-box"], "ip": ["tcp:7301"],
    "app": { "vyre.run/cap/vault": [ { "items": ["northwind-*"], "mode": "relayed" } ] } } ] }
```

Then in the box's config: `"vault": { "relay": { "identity": "whois", "grants": "require" } }`,
restart vyred, and check with `vyre call vault.grants.status`. `7301` is `vault.relay.port`.

### Guests from another tailnet

1. Admin console: Machines, the box, the "..." menu, Share, invite sam@harlow.example.
2. Either list them:
   `vyre call --tty network.guests.add '{"login":"sam@harlow.example","tools":["glass.open","glass.close","threads.list"]}'`,
   or grant them:
   ```json
   { "grants": [ { "src": ["sam@harlow.example"], "dst": ["tag:vyre-box"], "ip": ["tcp:443"],
       "app": { "vyre.run/cap/guest": [ { "tools": ["glass.open", "glass.close", "threads.list"] } ] } } ] }
   ```
3. `vyre call --tty network.guests.enable '{"on":true}'`, then `vyre call network.guests.check`.

### A tagged node for each agent (after the image change)

1. Policy (and remove any allow-all `"src": ["*"]`, which covers tags):
   ```json
   {
     "tagOwners": { "tag:vyre-agent": ["alex@example.com"] },
     "grants": [ { "src": ["tag:vyre-agent"], "dst": ["tag:vyre-box"], "ip": ["tcp:443"] } ]
   }
   ```
2. Admin console, Settings, Keys: a reusable, ephemeral, pre-approved key tagged `tag:vyre-agent`.
3. `vyre vault put tailscale-agent-authkey`, then `vyre vault grant tailscale-agent-authkey computers`.
4. `vyre call --tty computers.tailnet.set '{"enabled":true}'`.

### Webhooks through Funnel

1. Policy: `"nodeAttrs": [ { "target": ["tag:vyre-box"], "attr": ["funnel"] } ]`, and HTTPS on (above).
2. On the box:
   ```
   vyre hooks on
   vyre vault put northwind-orders-hook
   vyre vault grant northwind-orders-hook hooks
   vyre hooks open northwind-orders --scheme hmac-sha256 --header x-northwind-signature --secret northwind-orders-hook
   cd /srv/vyre && docker compose exec tailscale tailscale funnel --bg --https=8443 --set-path=/hooks/northwind-orders http://127.0.0.1:7310/hooks/northwind-orders
   ```
3. The sender posts to `https://vyre.tail0000.ts.net:8443/hooks/northwind-orders`. Check with
   `vyre hooks status`.
4. To close: `vyre hooks close northwind-orders`, then
   `tailscale funnel --https=8443 --set-path=/hooks/northwind-orders off`; after the last route,
   `tailscale funnel --https=8443 off`.

## Changed contracts

Listed by the area they touch, so the merge can go in order. Everything below is off by default.

- **relay** (28 Sep, own): `relay.join` refuses on darwin (`not_available_here`) until vyre-core
  (ADR 0040) holds the joining device's own key; new export `relayJoinRefusal(platform)`; its
  `presence.when` no longer always requires a proof (skips the prompt on darwin, since the call
  can only refuse there); its Touch ID prompt now sanitises the relay host the same way as the
  box's own name (shared `promptSafe` helper, widened to Unicode format/bidi characters, host
  capped at 64).
- **onboard**: tool `onboard.join` (`{ action: "status"|"tailscale"|"relay"|"verify", step?,
  node?, becomeDevice? }`), box role (matches onboard's own). Forwards only, through onboard's own
  functions for tailscale and ctx.call for relay/link/onboard.machine; reads and writes nothing of
  its own.
- **link** (own): tool `link.health`; `link.status` box gains `stableId`; `link.peers` rows gain
  `stable_id`; `parseWhois`/`capValues` in `core/link/transport.js` (whois carries `tags`, `caps`);
  link pairing refuses `tailnet-guest:*` and `tailnet:agent:*`.
- **names** (box's listener): `identifier` returns `kind` (owner, guest, agent); callers
  `tailnet-guest:<login>` and `tailnet:agent:<name>`; peer meta `{ node, stableId, login, tags,
  caps, kind, agent? }`; `core/names/guests.js` (`GUEST_SAFE`, helpers); `lockStatus`, `parseLock`,
  `peers`, `parsePeers` in `core/names/tailscale.js`.
- **daemon**: guests reach only their allowed tools within `GUEST_SAFE`, 404 otherwise;
  `tailnet:agent:*` also needs a matching `x-vyre-agent-key`; `tailnet-guest:` is a label the
  socket cannot claim.
- **network** (new module, box): `network.guests.list|add|remove|enable|check`; events
  `guest.added`, `guest.removed`; config `network.guests { enabled: false, people: {} }`.
- **presence**: HUMAN_ONLY gains `files.drive.share|unshare|access`, `network.guests.add|remove|enable`,
  `hooks.enable|open|close`, `computers.tailnet.set`, `computers.egress.set`; presence refuses
  `tailnet-guest:*` whatever the proof.
- **gate**: `person()` refuses guests and agent nodes.
- **memory**: `viaTailnet` no longer reads `tailnet:agent:*` as the owner.
- **vault**: config `vault.relay.grants` (`"off"`|`"require"`); whois relay meta gains `peer`;
  tool `vault.grants.status`; `vault.pass.create` may return `warning`; exports
  `relay.VAULT_CAP`, `relay.grantCovers`, `whoisMeta`.
- **files**: tools `files.send`, `files.drive.status|share|unshare|audit|url|mount|unmount|open|local`;
  events `files.sent`, `files.received`, `drive.exposed`; config `files.inbox`,
  `files.drive.shares`, `files.drive.access`; CLI `vyre send`.
  Taildrive per-share access (ea158df): tool `files.drive.access { name, mode }` answering
  `{ name, access, mount: { want, now, change, step? } }`; `files.drive.shares` entries may be
  `{ path, access }` (or `{ access }` for a default share); `files.drive.status` rows gain
  `access` (top-level `access` is rw when any share is); `files.drive.share` answers the share's
  own access and may refuse `unsafe_share` with `detail.found` (and `detail.tooBig`);
  `files.drive.audit` answers `unsafe: [{ share, found, why? }]`, and `drive.exposed` carries
  `unsafe`; `core/files/safety.js` exports `secretName`, `HOME_DENIED`, and the guard
  `isDenied`; `shareSpecs`, `mountStep`, `SCAN_LIMIT` exported from `core/files/drive.js`.
- **glass**: `glass.open` answers `link`; `glass.close` from a guest closes only its own sessions;
  config `glass.egress`.
- **computers**: tools `computers.egress.status|set`, `computers.tailnet.status|set`, internal
  `computers.node.agent`; events `computer.joined`, `computer.left`; `computers.watch` takes
  `slow`; `Pool.ticket(..., { slow })`; columns `egress`, `stable_id`, `node`; computer env
  `VYRE_PROXY_PAC`; `Inspection.ports.tailnet` (optional); manifest `needs.vault`
  `["tailscale-agent-authkey"]`; config `computers.tailnet`; new, unwired
  `image/computerd/tailnet.js`; `entrypoint.sh` PAC check.
- **watchers**: watcher.json `on` and `where` (schedule `"event"`), run trigger `"event"`,
  `watchers.test` takes `event`, runtime dep `listen`, `folder.matches` exported, the
  write-a-watcher skill documents it.
- **hooks** (new module, box): `hooks.enable|open|close|list|status|delivery`; events
  `hook.received`, `hook.opened`, `hook.closed`; table `hooks_deliveries`; config `hooks`;
  CLI `vyre hooks`.
- **onboard**: `onboard.tailscale` action `lock`; the HTTPS step shown as plain steps, Lock after it.
- **cli / install**: `vyre box add` and `move` prefer Tailscale SSH; `core/cli/tailnet.js` peers
  carry `ssh`; `ssh.js` opens `.ts.net` targets interactively first.
- **deck**: `deck/js/health.js` (one formatter, dots in Chat and Glass headers); `deck/js/lock.js`;
  Settings Network rows; new fixtures `files.json`, `hooks.json`, `network.json`, `link.json`.
- **capsule**: IPC `capsule:send-file`, preload `sendFile`, option-return on a file row,
  `SEND_TIMEOUT`, the box dot, Taildrive-first open.
- **box**: the tailscale service mounts `vyre-work:/work:${VYRE_DRIVE_ACCESS:-ro}`; new
  `box/compose.egress.yml`. Its services: `egress` is now the gate (vyre image, `node
  /opt/vyre/core/computers/egressgate.js`, alias `egress` on `computers`, also on `egress`),
  and the tailscaled sidecar is `egress-node` (SOCKS5 `:1056`, `TS_SOCKET` in the new volume
  `egress-sock`, networks `default` and `egress` only, `--advertise-tags=tag:vyre-egress`). New
  internal network `egress` (`vyre-egress`) and the project's `default` network. `PROXY`
  (`egress:1055`) is unchanged, so computers and the PAC need nothing new.
- **computers (egress)**: new `core/computers/egressgate.js` (env `VYRE_EGRESS_GATE_HOST`,
  `_PORT`, `_STATUS_PORT`, `VYRE_EGRESS_UPSTREAM`, `VYRE_EGRESS_SOCKET`; GET /status on 1057);
  `egress.gateStatus()` and `GATE_STATUS_PORT` (test override `VYRE_EGRESS_GATE_STATUS`);
  `computers.egress.status` gains `gate: { answers, allowed, reason } | { answers: false, why }`.
- **perf-check** (scripts/perf-check): waits for `memory.curate` after indexing, before the idle
  window, so Memory's startup pass is not counted as idle work.
- **names** (27 Sep): config `network.origins` (default `["https://app.vyre.run"]`); `names()`
  takes `webSession`; the router's peer may carry `origin` and `webSession`; cross-origin
  `GET /v1/health` answers `{ reachable: true }` in the listener; `401 web_session_required`.
- **names** (28 Sep): `GET /v1/whoami` on the direct tailnet path (not the hosted app's CORS
  path): owner or guest only (an agent's node gets `403`), rate-limited 10/minute per
  node/stableId (`429`), answers `{ kind, name }` (name only for the owner).
- **deck** (27 Sep, pwa's file): deck/views/settings.js, the Network share row is titled
  "VyreDrive" and its line reads "VyreDrive (built on Tailscale's Taildrive) opens your box's
  folders in Finder on your Mac." (was "...open in Finder on your Mac through Taildrive."), in
  both the on and off states (1498c4a).
- **presence** (27 Sep): `files.drive.access` is PERSON_ONLY, no longer HUMAN_ONLY.
- **names guests** (27 Sep): GUEST_SAFE drops `glass.open`.
- **files** (27 Sep): the share scan's skips and `.git/config` check (`gitConfigCredential`).
- **config/projects** (27 Sep): `workDir()`, `oldProjectsDir()`, `boxProjectsDir()`; a box's
  default `projectsDir` is `/work/projects` when `/work` exists; `core/projects/move.js`,
  event `projects.moved`, file `<vyre home>/projects-moved.json`.
- **config**: defaults for `glass.egress`, `computers.tailnet`, `hooks`, `network.guests`.

Suggested merge order: link and names, daemon and presence, vault, files, computers, watchers and
hooks, then deck, capsule and onboard. They are one branch here, so this matters only if the
integrator splits it.
