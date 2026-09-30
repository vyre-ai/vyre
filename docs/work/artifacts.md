# artifacts

Branch: work/artifacts · Worktree: ../vyre-artifacts · Plan: team/0.2/plans/artifacts.md (approved
by the user with all recommendations, 30 Sep) · Options page: team/0.2/artifacts-options.html

## Scope

Owns `core/artifacts/` (module, store, render, share server) and `lib/secret-text.js`. The card and
viewer UI (native-core, app-design) wait for app-design's screens and the user's OK.

## Done

- `core/artifacts`: create, update, get, list, search, versions, diff, restore, move, archive,
  delete/undelete (30-day Undo), export, share/unshare, public.status/set, capture.register. One git
  repository per artifact under `<home>/data/artifacts/store/<project>/<id>/` (per artifact, not per
  project, so a delete really removes every version and a move is a rename).
- Scope: an agent reaches only its thread's project (or "personal"); the person and Vyre's modules
  reach all. Agent-made artifacts are `untrusted` until P8's turn signal reaches the call.
- Capture: `artifacts.capture.register {thread, dir}` (reach modules, for sessions at spawn) plus
  the `floor.wrote {thread, path, bytes}` event; top-level .md/.html/.mmd/.svg files only, no
  symlinks, 5 MB.
- Private view: route `/v1/artifacts/content?id=&v=`, person only, CSP `sandbox` header,
  `frame-ancestors 'self'`.
- Public links: `share-server.js`, a separate process vyred never starts: the box image runs it as
  its own user (`--not-uid <vyred uid>`; it refuses vyred's uid and root) under `node --permission`
  (read and write only `<data>/public`), 127.0.0.1:7311, GET/HEAD `/s/<token>` only, 410 after stop
  or expiry, 404 while `.off` exists, 60 req/min per link. It writes `.server.json {pid, uid, port}`;
  vyred checks that pid's real uid (/proc or ps) before public links turn on, else `not_available`
  ("public links arrive with the next server update"). Snapshots carry no project, agent or thread.
  Secret scan refuses a share.
- Review fixes (reviewer-2, reviews/artifacts.md): H1 capture reads through an O_NOFOLLOW fd with
  folder dev/ino, one link, owner uid and (Linux) /proc/self/fd checks, with swap tests; H2 above;
  M1 only first-party modules are trusted (meta.firstParty); M2 a project-less agent or added module
  reaches only what it made; M3 kept as designed (lead 30 Sep: "always the latest" is the person's own choice,
  so every later version publishes; the share sheet must say so plainly, app-design); M4 `artifacts.public.base` (reach modules, first-party) split from
  `artifacts.public.set {on}`; L1 capture folders must be real, unlinked and outside vyred's home;
  L2 downloaded pages carry a meta CSP. M5 (frame self-navigation) is native-core's frame, L3 is
  share-sheet copy (app-design), L4 decided by the lead: the assistant (agents kind "assistant") reaches every
  project's artifacts, the person's own space included.
- Tests: core/artifacts/artifacts.test.js (10), share-server.test.js (1), lib/secret-text.test.js (2),
  plus boundaries, hygiene, modules, mcp-server-tools, docs-check green locally in temp homes.

## Doing

- 30 Sep: merged origin/work/stage-0.2 (795a00b7). Fixes: `thread.artifact` reserved (artifacts added to the thread owners in core/modules/index.js); the share test accepts the registry's held_unavailable for an agent; CHANGELOG conflict kept both sides. Route decision: `/v1/artifacts/content?id=&v=` stays (native-core adapts). CI on e6ae4f65: box-image and sessions-sdk green; node cancelled at the 30 min cap in the threads/sessions test file (same hang other branches and stage-0.2 show, sessions' runner item), all 11 artifacts tests and boundaries/hygiene/docs pass on both Node versions. Sha sent to integrator.
- Paused (usage-limit restart, 30 Sep). Head 07fee1c0 is CLEARED by reviewer-2 and handed to the
  integrator to land on stage/0.2, with the share-server-as-its-own-user image item. Nothing
  uncommitted. Resume: check CHAT.md for replies from sessions, tailnet, native-core, app-design and
  integrator, then Next.

## Next

1. sessions: call `artifacts.capture.register` at spawn and emit `floor.wrote` after allowed writes;
   pass the brief line and the spawn flags once AR-S1 lists them.
2. tailnet: Funnel `/s/` on 8443 to 127.0.0.1:7311 on `artifact-links.changed {on}`; set
   `artifacts.public.base {base}` (reach modules).
3. platform PL-M2: once the registry routes outward tools, drop the fail-closed check in
   `artifacts.share` (it accepts `meta.gate`) and let `asked` come from P17 (`meta.asked`).
4. iq: index on `artifact.updated`, drop on `artifact.deleted` (AR7).
5. integrator: run share-server in the box image as its own user with `--not-uid <vyred uid>`, a
   shared group on `data/artifacts/public` (dirs 0770, files 0640), restarted on failure; count
   `data/artifacts` in export. Mac box: the same under vyre-core's user split (M1).
6. Spikes AR-S1..S4 on GitHub-hosted runners.
7. Typed renderers (chart, Mermaid, slides) after app-design's specs; the card and panel with
   native-core.

## Needs from others

- sessions: `floor.wrote` event and the register call (agreed shape, CHAT 06:42 and follow-up).
- tailnet: the Funnel path and `base` (AR6, agreed).
- platform: PL-M2 outward routing, `meta.asked`.
- integrator: share-server as its own user in the image (a condition for public links, H2).
- native-core: M5, blank the artifact frame on a second load (self-navigation).
- sessions: pass the agent's uid in `artifacts.capture.register {thread, dir, uid}`.

## Changed contracts

- `scripts/lib/docs/terms.js`, `scripts/lib/docs/reference.js`, `test/docs-check.test.js`: read
  object tool entries (`{name, reach, outward}`) as their name. The first built-in module.json with
  object entries broke the docs reference (docs owner, one line each).
- Event `artifact-links.changed {on, port, path}` for tailnet (event names are two-part, so not
  `artifacts.public.changed`).
- Public tokens are kept in vyred's database so the person can copy the link again; the public
  folder is keyed by the token's sha256, so its listing never reveals a link.
