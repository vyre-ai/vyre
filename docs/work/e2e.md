# e2e

Branch: work/e2e · Worktree: ../vyre-e2e

## Scope

Install and use Vyre from main (d1f7b75) the way docs/JOURNEY.md says, on the test box
and on this Mac, and fix or report every snag. The live box in /srv/vyre is the user's and was
not touched: not its compose project, volumes, `vyre:local` image, Tailscale node or
/usr/local/bin/vyre.

## Verdict

The user can install today and walk the onboarding, now that 4a1a4f7 is merged. Before that fix,
step 1 would not let the user continue on any box without a vyre.run zone token. Everything after
step 3 needs the box on the user's real tailnet: the address, the first passkey, the Deck, Chat,
Agents, Vault and pairing the Mac. So this run proves the install and the onboarding up to
Tailscale's sign-in, and not the part after it.

## Steps on the test box, as the user would type them

On the server:

```
curl -fsSL https://vyre.run/install.sh | sh
```

It prints the onboarding link and an `ssh -N -L 7300:127.0.0.1:7300 <user>@<host>` line. On the
Mac, run that line, open the link, and walk the six steps. Tailscale's Connect opens
login.tailscale.com: sign in with the same account as the Mac. Then press Turn on HTTPS on the
address step if it asks. The passkey and the Deck follow at `https://vyre.<tailnet>.ts.net`.
Then, on the Mac:

```
npm i -g https://vyre.run/box/vyre.tgz
vyre up
```

With the Mac on the same tailnet, `vyre up` finds the box, and the user approves the Mac in the Deck.

## What this run did, and what happened

| step | what | result | time |
|---|---|---|---|
| 1 | build-site.sh from main, then release-check.sh --skip-tests (perf on) | all good; vyre-0.0.1.tgz, 437 files, 1376 KB | 3 s + 99 s |
| 2 | scp site/box to the test box, serve it on 127.0.0.1:18080, `curl .../install-box.sh \| sh` with VYRE_BOX_URL, VYRE_DIR=/srv/vyre-e2e, VYRE_WRAPPER=/srv/vyre-e2e/bin/vyre | image built from vyre.tgz, stack up, link printed with the ssh -L line | 67 s |
| 3 | onboarding over `ssh -L 7300:127.0.0.1:7310`, headless Chrome with a virtual authenticator | step 1 blocked (snag 1); after the fix: alex, Continue, Claude skipped, Tailscale Connect gave a real login.tailscale.com link, then skipped; address, history and devices skipped or continued | about 1 min |
| 4 | "finish later": `vyre up` on the box again | a fresh one-time link; the page keeps every step's state and resumes | 3 s |
| 5 | Open the Deck on the last screen | "Your address is not set up yet, so this page cannot open the Deck." Loopback returns 403 for /now, /v1/*, the Deck, Chat and Vault | |
| 6 | passkey | not reachable: the first passkey is made only at the box's address (onboard.passkeyUrl), and there is none without Tailscale | |
| 7 | `vyre update` with the fix in a new vyre.tgz | fetched, verified against SHA256SUMS, rebuilt and recreated; new link printed | 71 s |
| 8 | Mac: `npm i -g --prefix <scratch>` of the same tgz | 47 packages, 485 MB (snag 5) | 3 s (warm cache) |
| 9 | Mac: `vyre up`, 3 "I already set up a box", `127.0.0.1:7300` | vyred started; "your box https://127.0.0.1:7300 did not answer from here · this Mac is not on the tailnet" | 19 s |
| 10 | Mac: `vyre`, `vyre status`, `vyre threads`, `vyre link` | home lists no projects and no agents; status running, 17 modules; threads prints nothing (snag 6); link "not paired" | 1 s each |
| 11 | Mac: `vyre capsule --dev --hidden` | needs Electron in local/capsule (installed it into the temp package); came up ready, no window, stream open; wrote to the real Application Support/Vyre (snag 8) | 10 s |

The Mac ran with HOME and VYRE_HOME in temp folders, and a fake signed-out `tailscale`
(VYRE_TAILSCALE_BIN). With the real Tailscale, link.find would have found the user's live box on
the tailnet and asked it to pair.

## Snags

| # | snag | fix or owner |
|---|---|---|
| 1 | Onboarding step 1: Continue stays disabled for every name, "That name is not free: could not check: no Cloudflare token". test/journey calls onboard.you directly and never touches the page, so it missed this | fixed, 4a1a4f7 |
| 2 | Step 1's name input had no `input` class, so it looked unstyled | fixed, 4a1a4f7 |
| 3 | `vyre up` gave the first vyred 5 s and then said "did not start", with an empty vyred.out, while vyred was still starting | fixed, 37cf5eb (15 s) |
| 4 | Step 6: the Mac column overflows the panel at 1280 px; the phone QR encodes 127.0.0.1:7300/now with no address; step 5 on a box says "on this machine" and "100% ranked"; NAME_RE rejects a display name like "Alex Rivera" | polish-surfaces |
| 5 | `npm i -g` is 485 MB: onnxruntime-node and onnxruntime-web come in through the optional embedder. release.md says 690 KB and the tgz is 1376 KB | polish-cli (with recall) |
| 6 | Bare `vyre threads` prints nothing; `vyre threads --help` crashes with "--help needs a value" | polish-cli |
| 7 | One VYRE_HOME reached by two paths runs two vyreds on one store, and the pidfile names the wrong one | polish-cli |
| 8 | The Capsule's Electron userData is always ~/Library/Application Support/Vyre, even with a temp VYRE_HOME, so dev and test runs write into the user's real Capsule data | capsule-pro |
| 9 | A second box on one server needs workarounds: compose.yml fixes the project name, network names (vyre, vyre-computers, vyre-docker-api), the 7300 host port, and compose.build.yml the vyre:local tag. The installer writes /usr/local/bin/vyre. This run used a pre-written .env (COMPOSE_PROJECT_NAME=vyre-e2e) and a compose.e2e.yml override | box/install; only matters for testing beside a live box |
| 10 | Passkey, Deck, Chat, Agents, Vault and Mac pairing cannot be checked without a real tailnet login | done on a private headscale tailnet, 27 Sep (below) |
| 11 | local/capsule changed since the live Capsule zip (2e795b8 vs 16613ae), so the next release.sh rebuilds and uploads Vyre-mac.zip | lead, at release |

| 12 | The box's Deck is called as `tailnet:<owner>`, and every tool whose callers list names `deck` refused it with 403: gate.get/approve/reject (held items could not be approved from the Deck or a phone), push.devices/settings, agents.delete, vault.update (Seal it did nothing) | fixed, 41f1e21 (`callerAllowed` in core/modules) |
| 13 | Settings showed `<name>.vyre.run` as the address of a box served at its ts.net name | fixed, 41f1e21 |
| 14 | agents.list left out `instructions`, so every agent page said "No instructions yet" and Edit opened empty (saving would erase the job) | fixed, 08deeb9 |
| 15 | No Deck screen shows `link.pending` or approves a Mac, yet `vyre up`, `vyre link` and `vyre link approve` on the box all say "approve it in the Deck". And link.pair.approve refuses the Mac's own node ("a Mac cannot approve its own pairing"), so the Deck in the Mac's browser cannot approve even through the API. Today a Mac pairs only from another device (a phone) by calling the API by hand | deck/link (a decision, see Needs) |
| 16 | Vault: after a refused vault.update the editor closes and says nothing; the Deck calls `vault.usage`, which main does not have (404) | vault-deck |
| 17 | Onboarding: revisiting "Your address" after it serves says "Not reserved yet" until Get your address is pressed again; reopening /onboard without a token (a new browser) shows step 1 empty with Continue disabled and no hint to run `vyre up --print-link` | polish-surfaces |
| 18 | With Claude skipped, the end screen says "juno is ready when you are" while Agents says "No assistant yet. Onboarding makes one." (none is made without a Claude sign-in) | polish-surfaces |
| 19 | Live box, step 2: the Claude sign-in code never submitted. The code and Enter went into `claude setup-token` in one write, Ink reads that as a paste, and the page waited 60 s in silence | fixed, a10fcec (Enter on its own; OAuth errors reported at once) |
| 20 | Live box, step 4 claimed a public `<name>.vyre.run` after step 1 was skipped: step 1's live check saved every name it checked | fixed, b405bfc (checks save nothing; vyre.run needs a confirmed name) |
| 22 | The New agent form's "Give it its own computer" box is ticked but the agent is made with computer false | deck (agents view) |
| 21 | Slow steps gave no sign of time: the address takes about a minute | fixed, b405bfc (time up front, elapsed seconds per line) |

## Headscale run (27 Sep): everything after Tailscale

A private tailnet on the test server, torn down afterwards. Harness and how to rerun it:
scripts/e2e-headscale/README.md. headscale 0.29.4; the box from this branch (vyre-e2e:local); a
stand-in Mac node (tailscale, headless Chrome and a role-local vyred in one namespace) and a phone
node. A throwaway CA trusted only in the e2e Chrome profile and the Mac vyred. The one shim:
`tailscale cert` and CertDomains, which headscale lacks.

Works end to end, on a clean box with the fixed image (onboarding 75 s):

| step | result |
|---|---|
| loopback onboarding, Claude skipped | fine |
| Tailscale Connect | the page shows the sign-in link from AuthURL; signing in (registering the node as alex) moves it to done, `vyre.tail0000.ts.net at 100.64.0.2` |
| address | ts.net fallback, certificate, serving; owner alex@example.com from the node's login |
| Switch to the address | lands on /onboard/passkey over TLS, caller identified by whois |
| first passkey | made (virtual authenticator), rpId vyre.tail0000.ts.net |
| history, devices, Open Vyre | the Deck, "On your tailnet" |
| Now, Projects, Memory, Agents, Chat, Vault, Settings | load, no console errors after the fixes |
| Vault | Add item, Seal it, "Confirm it's you", Use passkey: item sealed, history `tailnet:alex@example.com` |
| Agents | New agent kit with a job; the page shows the job. Talk to kit: "kit cannot start: claude-setup-token is not granted" (no Claude account here) |
| Mac `vyre up` | finds the box (link.find: cert SAN, /v1/health, whois pin), asks to pair, prints a code |
| approve in the Mac's own browser | refused: a Mac cannot approve its own pairing (snag 15) |
| approve on the phone node (passkey synced from the Mac) | approved; the Mac says `linked to alex`; `link.call vault.list` from the Mac returns northwind-mail |

What only a real Tailscale account can prove: the login.tailscale.com sign-in page and its link
(`up()` only matches login.tailscale.com, so a headscale run relies on AuthURL); `tailscale cert`
and the "Turn on HTTPS" step; MagicDNS resolving the box's name on a real Mac; Touch ID or a
synced iCloud passkey instead of the virtual authenticator; Claude-backed Chat and agents; the
Capsule on macOS.

### Tailnet "verify on first real run" checks (tailscale 1.102.5)

| check | result |
|---|---|
| Health: ping line | direct: `pong from vyre (100.64.0.2) via 172.21.0.4:36876 in 1ms`. DERP and peer-relay lines not reachable here (no peer relays in headscale) |
| Taildrop: `file get --verbose` | `wrote order sheet.txt as /tmp/inbox/order sheet (1).txt (19 bytes)`; with `--wait --loop` each line is prefixed by `waiting for file...` with no newline. parseWrote reads both |
| Taildrop: TaildropTarget | 1 for the owner's untagged box; 9 for a tagged box, `NoFileSharingReason` empty, and `file cp` says "peer is owned by a different user" |
| Taildrop: grant form for a tagged box | not checkable: headscale refuses any tailscale.com capability in grants |
| Grants in whois CapMap | top-level `CapMap`, e.g. `{"vyre.run/cap/vault": [{"items": [...]}], "vyre.run/cap/guest": [{"tools": ["threads.get"]}]}`, for an untagged and a tagged destination. parseWhois matches. Shared-in nodes: not in headscale |
| Node attributes in Self.CapMap | `drive:share` and `drive:access` appear as keys with value null (drive.js uses hasOwnProperty, so fine). `funnel` is refused by headscale |
| Taildrive | `tailscale drive share` works; WebDAV at 100.100.100.100:8080 lists `/<tailnet>/`, where the segment is CurrentTailnet.Name (drive.js agrees). Reading a share needs the tailscale.com/cap/drive grant: not checkable |
| Tailscale SSH | the peer carries `sshHostKeys`; `ssh root@<magicdns name>` in BatchMode gets in with no key. Check mode prints the sign-in URL on stderr and holds, as box add expects |
| Funnel | `--bg`, `--https`, `--set-path` exist; `funnel status --json` is `{}`; without HTTPS both on and off say "Funnel not available; HTTPS must be enabled" |
| Egress: compose config | `docker compose config` on compose.yml plus compose.egress.yml passes |
| Egress: containerboot | runs with read_only, cap_drop ALL and the tmpfs list; tailscaled gets `--state=mem:`; SOCKS5 on :1055 |
| Egress: through the Mac | yes: 2 MB through SOCKS5 shows on the Mac's tailscale0 |
| Egress: Mac off the tailnet | fails closed (curl exit 97) |
| **Egress: Mac stops offering the exit node, or its route is unapproved** | **goes out directly, silently**: 200, 0 bytes on the Mac. The site sees the datacenter address. tailnet should refuse SOCKS while the exit node is not offered (ExitNodeOption false), e.g. in the planned authenticating front |
| **Egress: restart with a single-use key** | "authkey already used"; the sidecar never comes back. A reusable ephemeral key (or the planned OAuth client) survives restarts |
| Egress: Chrome with a data: PAC | the computer image's Chromium honours it: a listed site goes through the Mac, others direct, and the listed site fails when egress is down. chromedp/headless-shell ignores every PAC (data: or http), so never test PAC with it |
| Agent nodes | not built yet (waits on the image change) |

## Glass over the tailnet (27 Sep, work/e2e + work/glass-live dcf7b18)

On the headscale harness with the computers profile (the box's own Docker proxy, image
vyre-e2e/computer:0.1, network and label prefix, so the live box's computers were out of reach):
New agent kit, Give kit a computer (the create form's computer box did not stick: `computer:
false`; the agent page's button worked), then /glass/kit in the stand-in Mac's Chrome. The computer
started on first view (about 20 s), and noVNC drew kit's Chromium at 1440 x 900, LIVE, over the
box's HTTPS address (the ticketed stream /v1/streams/computers/glass through the tailnet listener).
Take over: glass.take answered presence_required, the page offered Confirm with passkey, the
virtual authenticator asserted, and "You have control". Clicks and keys reached the screen (typed
example.com in kit's address bar; the page loaded). Hand back also asks for the passkey
(glass.release is on the presence list): is that intended? Torn down afterwards, including the
computer container and its home volume.

## HTTP listener audit (27 Sep, after logout 3, on main ef51363)

Question: can a process that is not the person act as the person over HTTP? Yes, three ways.

| listener | bind | reach | auth | caller | risk |
|---|---|---|---|---|---|
| names (the tailnet HTTPS) core/names/service.js | the box's tailnet IPs :443 | every tailnet node | whois; Host, JSON-only POST and Origin checks | `tailnet:<login>` for any node of the owner | HIGH |
| onboard core/onboard/loopback.js | 127.0.0.1, or the `vyred` alias on the `vyre` network (host 127.0.0.1:7300) | host loopback, the `vyre` network (computers are not on it) | one-time token, loopback Host, Origin | `onboard` | low |
| hooks core/hooks/listener.js | 127.0.0.1, published by Funnel | the internet | per-route token, never calls a tool | `hook` | low |
| vault relay core/vault/relay.js | 127.0.0.1 (forced in tailscale mode) | local, tailscale serve | signed holder envelope | `pass:<id>:<holder>` | low |
| vault fill core/vault/fill.js | 127.0.0.1 (0.0.0.0 if configured) | local | Host allowlist, extension Origin, device token | none | medium: a script can send `Origin: chrome-extension://..`; vault.devices and vault.device.revoke have `callers: null` |
| vault kit, google connect | 127.0.0.1:0, while open | local | one-time path token / OAuth state | none | none |
| ssh agent core/vault/ssh/agent.js | unix socket 0600 | same uid | per key+host approval, then a lease | none | low |
| computerd | 0.0.0.0 in each computer | vyre-computers, the computer's tailnet node | per-computer bearer (plain `===`) | none | low |
| egressgate, docker-api proxy | 0.0.0.0 on internal networks | vyred's namespace, computers | none | none | low (status leaks a reason; docker-api can stop computers) |
| vyred socket core/daemon/index.js | unix socket 0600 | same uid | label + peer ancestry for person actions | label | HIGH (below) |
| agent computer (glass-live 70a72036, reviewed 27 Sep) | computerd, CDP over a pipe, Xvnc with a cookie | the agent (uid 1000) in its own container | token, untrusted X cookie, freezer during a shield | none | HIGH until fixed: token and VNC password in Config.Env (every exec reads them); CDP denylist leaves cookies, file:// and chrome:// open |

Findings:

1. Any process on any owner node is the Deck. names labels every request from an owner-login node
   `tailnet:<login>`; `callerAllowed` opens every tool whose callers list names `deck` to it; the
   ancestry check runs only on the socket. The Host/JSON/Origin checks stop web pages, not curl.
   Reachable with no proof: threads.answer (a Claude Code on the Mac answers its own permission
   ask), gate.revise/reject, gate.approve on items that need no proof, agents.create/update,
   term.open (a shell on the box, then its WebSocket), glass.take, computers.takeover.
   HUMAN_ONLY tools still need a passkey proof, which a script cannot make.
2. link.call launders the Mac socket's check (core/link/mac.js link.call, no callers list):
   the socket checks the outer tool name, remote() blocks only link.*, and the box sees
   `tailnet:<owner>`. A model on the Mac calls `link.call {tool:"threads.answer"}` through the
   socket or MCP.
3. The socket ancestry check is escaped by an orphan. A model's Bash runs
   `nohup sh -c "sleep 1; vyre call threads.answer .." &`; once the shell exits the child's parent
   is 1 (checked on this Mac: ppid 1), the chain reaches init "complete" with no claude above, and
   the call passes. setsid and a daemonized tmux server do the same, and env markers are the
   model's to clear. Same uid means a model's shell can reach whatever the person's shell can.
   Hard lines are only user presence (passkey, Touch ID) and a different uid.

Plan (to the lead before building):
- A person session over HTTP. `tailnet:<login>` becomes a device of the owner, not the person:
  PERSON_ONLY, HUMAN_ONLY and presence-needing calls over the tailnet also need a person session.
  Made by a passkey sign-in at the box's address, 30 days sliding, 90 days max, listed and
  revocable in Settings, pinned to the tailnet node it was made on. Same-origin Deck and phone
  PWA: `__Host-` cookie, HttpOnly, Secure, SameSite=Strict (plus today's JSON/Origin checks).
  Hosted app at app.vyre.run: no cookie (third-party in Safari); a sign-in hop to the box's page
  (passkey there, rpId stays the box), a one-time code back to app.vyre.run, exchanged with a
  PKCE verifier over CORS for a bearer token in `Authorization`, held with a non-extractable
  WebCrypto key that signs each request (DPoP style). Not ambient, so CSRF-safe; CORS names only
  https://app.vyre.run. Existing 30-min presence sessions stay the proof for HUMAN_ONLY.
- The Capsule: its presence key (kind capsule) opens a person session; link.call passes it
  through. link.call refuses PERSON_ONLY and presence-needing tools without one, and the Mac socket
  runs the person check on link.call's inner tool.
- Residual, stated plainly: a same-uid process can read browser storage from disk (Chrome's
  cookie store is keychain-encrypted, Safari's is TCC-protected; IndexedDB keys are not). The
  session raises the bar from one curl to stealing a browser's store.

## Doing (27 Sep, after logout 3)

Handed to the integrator: bb0415f8 on main fb1ed1d1 (the floor follows symlinks, `..` and hard
links; the per-thread socket efb02b2c; phone fixes e5aaf881). Waiting: box-deploy's candidate
sha for the headscale gate (setup in /srv/vyre-e2e: run1.sh, run2.sh <link>, run3.sh, then the
person-session checks); sessions wiring VYRE_SOCKET, then the split on.



/srv/vyre-e2e; `./run1.sh`, `./run2.sh <link>`, `./run3.sh`, then the person-session checks in
the 27 Sep notes above). Follow up: sessions' three changes, glass-live's two HIGH, relay's
relay.device.presence.

## Earlier (27 Sep, after the restart)

Done this session: main c48959b merged in (fc80279); the no-nag agents reversal and the SSE
`: open` byte at 61692fd, pushed, sha sent to the integrator and the lead. The docs "403
not_owner" is world setup (127.0.0.2 fails isTailnet before whois; docs' local 0039172 maps it to
100.64.0.2), told docs.

Also 5b30ed3 (pushed): asks and held items carry `presence: {required, covered}`; gate.revise,
gate.reject and threads.answer off the floor; gate.approve asks only for send/spend (NARROWABLE)
and is sessionable (x-vyre-presence-keep: 1 returns x-vyre-presence-session). Shape sent to pwa,
chat, mobile, phone-design. Lead decided: Gate deletions ask; a presence session lasts 30 min from the proof, no idle cutoff
(done in the commit after 5b30ed3).

Waiting for the integrator's deployed sha. Then: build a throwaway box from it on the test box
with scripts/e2e-headscale (README there), never /srv/vyre, and report pass or fail per item to the
lead: onboarding; same-Mac pairing through the Deck card (pwa's pair.js); Claude sign-in fresh-code
path (refusal at once plus "Open it again"); agents made and edited in the Deck with NO passkey
(New agent, Give a computer, job, model); Glass take (passkey) and hand-back (none); the phone PWA
send queue (touch a fake transcript on the box within ACTIVE_MS); tailnet's egress list (gate,
status fields per case, recovery within 2 s, restart with a reusable key, Chromium data: PAC); the
event stream's first byte. Tear down afterwards.

## Next

- The standing rule itself: Touch ID only for pairing a new device, revealing or granting vault
  secrets, and sending, posting or paying as the user outside; one proof covers a ~30 minute
  presence session per device. Owners elsewhere.

## Needs from others

- Done 27 Sep: the asking Mac approves its own pairing with a fresh passkey and its code
  (a3652ab; the Deck card is pwa's pair.js). glass.release needs no presence (0d648df). box add
  waits for the switch and mints the pairing code once a passkey exists (8faaef7).
- pwa: snags 16, 17, 18 and 22 (sent).

- deck and link (lead decides): a Deck card for `link.pending` with the code and Approve/Deny
  behind presence (snag 15), and whether the Mac's own browser may approve its own pairing once a
  passkey proves presence. Without one of these, a user with only a Mac cannot pair it.
- tailnet: the two egress findings above (direct fallback when the exit node is not offered;
  single-use key and restarts).
- vault-deck: snag 16. polish-surfaces: snags 17 and 18.

## Changed contracts

- core/spawner: spawnAsAgent(argv, { env, cwd }) -> ChildProcess-like (pid, stdin, stdout, stderr,
  kill, exit). VYRE_SPAWNER_SOCKET (/run/vyre/spawner.sock), VYRE_SPAWNER_ALLOW (extra programs,
  colon-separated). Image: users vyre (1000), vyre-agent (1001), group vyre-work (1002); CMD is
  core/spawner/main.js. compose: vyre service user 0:0, cap_add SETUID SETGID KILL, volume
  vyre-agent-home.

- link: link.signin / link.signout (callers cli, local, capsule), link.status.signedIn,
  events link.signed-in / link.signed-out. remote() carries PERSON_ONLY tools with the Mac's
  person session for person callers only; HUMAN_ONLY never rides the link. presence.person.start
  accepts `return` = http://127.0.0.1:<port>/cb/<nonce> (a Mac's vyred, traded with no Origin).
- vault fill: Fill({ extensions }) from vault.fill.extensions; pair(body, headers) keeps the
  Origin and an optional ES256 `key` (vault_meta device-origin:/device-key:); a key-bound
  device must send `x-vyre-proof` (same format as the person session). vault.devices and
  vault.device.revoke callers cli, local, deck, capsule. handle(route, body, headers, { raw, path }).

- Person session (core/presence/person.js). Over the tailnet (`tailnet:<login>` callers) the
  registry refuses PERSON_ONLY and presence-needing tools without `meta.person`, which only the
  router sets, from the cookie `__Host-vyre_person` or `authorization: Vyre <id>.<secret>` plus
  `x-vyre-proof: t=<ms> n=<nonce> sig=<b64url>` (ES256 P1363 over
  `METHOD\npath?query\nsha256b64url(body)\nt\nn`). 401 `person_session_required`. Exempt:
  presence.person.start and presence.enroll. Routes POST /v1/person/token {code, verifier, key},
  POST /v1/person/end. Tools presence.person.start {cc?, return?, label?} (with cc, return must be an allowed https origin, network.origins; the answer carries redirect) (HUMAN_ONLY), .status, .sessions,
  .revoke (PERSON_ONLY). Events presence.signed-in, presence.signed-out. A request tailnet marks
  cross-origin (peer.origin) is refused without a session. Tests standing in for a signed-in Deck
  pass `person: { id, kind }` in meta.

- link.call / ctx.remote refuse PERSON_ONLY and HUMAN_ONLY box tools: `person_session_required`.

- core/modules: `callerAllowed(callers, caller)`. A `tailnet:<login>` caller (the names listener
  admits only the owner) may use any tool whose callers list names `deck`; `tailnet:agent:*` and
  `tailnet-guest:*` may not. The registry and vault.update use it.
- agents.list: each entry now carries `instructions`.
- agents.create: no presence, callers cli, local, deck, capsule, module (and the owner over the
  tailnet). agents.update: no presence; the same callers plus mcp, where only the assistant passes,
  and only for name, instructions, model, effort and description. Refusals are `denied` (403).
- /v1/events/stream sends `: open` as its first body bytes.
- PERSON_ONLY adds agents.create, agents.update, gate.revise, gate.reject. A socket call to a
  PERSON_ONLY tool from under a `claude` or a thread process is refused `denied` (core/daemon/peer.js).
  threads.answer refuses the ask's own thread. Internal tool threads.pids.
- work/e2e now contains work/chat 2551cb9 (merged in 64a7d1d for PERSON_ONLY).
- threads.asks, threads.get asks, gate.held, gate.get: each item has `presence: {required, covered}`.
  gate.revise, gate.reject, threads.answer: no presence. gate.approve: presence for send, spend
  and delete, sessionable. A presence session lasts 30 minutes from the proof. Request header `x-vyre-presence-keep: 1` + strong proof returns
  `x-vyre-presence-session: session id=.. secret=.. expires=..`. Internal tool presence.covered.
- presence.covered returns `{ covered, since, expires }`; items and asks carry
  `presence: { required, covered, since }` (since in ms, null when not covered).
