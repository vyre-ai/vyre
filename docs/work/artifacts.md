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
- Public links: `share-server.js`, a separate process under `node --permission` (read and write
  only `<data>/public`), 127.0.0.1:7311, GET/HEAD `/s/<token>` only, 410 after stop or expiry, 60
  req/min per link. Snapshots carry no project, agent or thread. Secret scan refuses a share.
- Tests: core/artifacts/artifacts.test.js (7), share-server.test.js (1), lib/secret-text.test.js (2),
  plus boundaries, hygiene, modules, mcp-server-tools, docs-check green locally in temp homes.

## Doing

- Nothing in flight.

## Next

1. sessions: call `artifacts.capture.register` at spawn and emit `floor.wrote` after allowed writes;
   pass the brief line and the spawn flags once AR-S1 lists them.
2. tailnet: Funnel `/s/` on 8443 to 127.0.0.1:7311 on `artifact-links.changed {on}`; set
   `artifacts.public.set {base}` as module:network.
3. platform PL-M2: once the registry routes outward tools, drop the fail-closed check in
   `artifacts.share` (it accepts `meta.gate`) and let `asked` come from P17 (`meta.asked`).
4. iq: index on `artifact.updated`, drop on `artifact.deleted` (AR7).
5. integrator: run share-server as its own uid in the box image; count `data/artifacts` in export.
6. Spikes AR-S1..S4 on GitHub-hosted runners.
7. Typed renderers (chart, Mermaid, slides) after app-design's specs; the card and panel with
   native-core.

## Needs from others

- sessions: `floor.wrote` event and the register call (agreed shape, CHAT 06:42 and follow-up).
- tailnet: the Funnel path and `base` (AR6, agreed).
- platform: PL-M2 outward routing, `meta.asked`.
- integrator: share-server uid in the image.

## Changed contracts

- `scripts/lib/docs/terms.js`, `scripts/lib/docs/reference.js`, `test/docs-check.test.js`: read
  object tool entries (`{name, reach, outward}`) as their name. The first built-in module.json with
  object entries broke the docs reference (docs owner, one line each).
- Event `artifact-links.changed {on, port, path}` for tailnet (event names are two-part, so not
  `artifacts.public.changed`).
- Public tokens are kept in vyred's database so the person can copy the link again; the public
  folder is keyed by the token's sha256, so its listing never reveals a link.
