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

## Spikes (0.2.2, 2 Oct)

- AR-S4, answered from sessions' recorded ACP streams (core/sessions/testing/real): both Codex and Grok
  tell Vyre they may use the client's file calls (`fs.readTextFile` and `writeTextFile` are advertised
  true in the handshake). Grok then really writes through `fs/write_text_file` (one in the plan-and-edit
  turn, two `fs/read_text_file`), so Vyre as the ACP client sees the path and the content of every Grok
  write and can emit `floor.wrote` itself. Codex does not: its edit turn is a shell command
  (`printf 'hello\n' > hello.txt`) run in its own sandbox, with no `fs/write_text_file`, so a Codex file
  reaches Vyre only by the folder watcher (or a completed tool call carrying a diff). For artifacts:
  `floor.wrote` for Grok comes from the ACP write; for Codex it needs sessions' folder watcher on the
  thread's artifacts folder. The folder watcher is the one path that covers both, which is what
  capture already assumes.
- AR-S1, Claude Code 2.1.268 measured on the test box (`claude -p --output-format stream-json --verbose`,
  the init event's tool list): the built-in tools are Task, Bash, Cron*, DesignSync, Edit, Enter/ExitWorktree,
  ListAgents, LSP, Monitor, NotebookEdit, PushNotification, Read, RemoteTrigger, ReportFindings,
  ScheduleWakeup, SendMessage, Skill, TaskOutput, TaskStop, ToolSearch, WebFetch, WebSearch, Workflow, Write.
  There is no Artifact or publish tool in a headless session (the `Artifact` tools appear only in interactive
  sessions on a claude.ai login). What does publish or host content, and send as the person, is the account's own
  claude.ai connectors, which load by default in every session of a logged-in account: Claude Docs (`create`,
  `update`, `export`), Google Drive (`create_file`, `share_file`), Notion (`create-pages`, `create-file-upload`),
  Slack (`create_canvas`, `send_message`), Gmail (`send_message`, `create_draft`) and Calendar. The switch
  is `--strict-mcp-config` with Vyre's own `--mcp-config` (sessions already uses it for the no-tools mode,
  core/sessions/claude.js), which removes all of them; `--disallowedTools "mcp__claude_ai_Claude_Docs__*"`
  removes one family. For Vyre sessions the artifacts brief line alone does not stop a model using its own Docs
  connector: sessions should pass `--strict-mcp-config` on every Vyre-started Claude session.
  Codex and Grok were not run: the CLIs are not on the test box. Their ImageGen tools make media (not publish
  to a host); a headless tool list for each needs the CLI installed on a runner with an account, which is
  sessions' real-account study area (they hold the fixtures).
- AR-S3 (Funnel for a second tailscaled node in its own container, and a userspace second node on a Mac server)
  needs a Tailscale auth key and a throwaway tailnet; it is tailnet's to run. Nothing here changes until it does:
  public links stay off, with a plain message, until the share server runs under its own user.

## Doing

- 1 Oct: generated media built (core/artifacts/media.js, store.writeMedia, ingestMedia and the three media tools in index.js, content route with Range): tests in media.test.js and a round trip in backup.test.js. Waits: drive's entry shape (virtual entry served by artifacts, lead's ruling), sessions' register call, native-core's inline card (img src = the content route, thread.artifact carries mime and bytes). 0.2.1: thumbnails, gallery, audio polish, quotas, public links for media.
- 1 Oct: AR8 done: names/backup.js INCLUDE gains data (skips .server.json); box/vyre's vyre-home line names artifacts; round trip in core/artifacts/backup.test.js (versions, diff, data file, deck image, archive, delete + undo, # tag, share-server state left out); uninstall purge covers it (the store sits under the Vyre home). Spikes AR-S1..S4: see below.
- 1 Oct (user ruling, via lead): agents own the design inside an artifact. draw/theme.js validates colours, fonts, lengths and data-URI images; chart, deck, Mermaid, Markdown and SVG accept themes; SVG cleaner loosened to keep styles, gradients, filters and data-URI images. Tests in draw.test.js. Security unchanged: static pages, CSP, escaping, no remote loads. Needs reviewer-2.
- 1 Oct: reach sweep: public.set is reach person (its asked-recorders line removed); every mutating artifacts tool that declares reach anyone now names its guard in test/reach-anyone.json (own-scope check, the Gate for share). Merged work/plat-reach-own (41c45716).
- 1 Oct: typed renderers built (core/artifacts/draw/: chart, diagram (flowchart + sequence), svg cleaner, deck) per app-design's artifact-renderers; static pages (CSS-only tabs, zoom, filmstrip via #sN anchors), tests in draw.test.js; looked at in WebKit (qlmanage thumbnails, no Chrome). Not built: keyboard arrows, swipe, copy source, present mode (need a script; the parent frame or a later small first-party script), file-based images in decks. Chart spec format documented in the create tool.
- 1 Oct: # provider conformed to platform's core/mentions: search reach person (runs as the person), resolve forwarded as module:sessions/assistant {id, thread, said}, thread must exist, answers {name, hint, note, grant:{read,access}}; not_found thrown. Next: spikes AR-S1..S4 on runners, typed renderers once app-design's specs exist, AR8 export.
- 30 Sep: tag grant built: `artifacts.mention.resolve {id, thread}` from a first-party module records artifacts_grants; get/versions/diff read a granted artifact across projects. sessions calls it with the thread on the person's turn. Not yet: lineage (sub-thread inheriting), revoke on 'stop using'.
- 30 Sep: `#` mentions provider: module.json `mentions` (top level) plus artifacts.mention.search/resolve (reach modules). Waiting on platform's mentions.search fan-out and the field's real shape; a mention across projects gives an agent no read access yet (sessions/platform to decide the grant). Local rule: only my own test files locally, never the full suite or Chrome.
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
