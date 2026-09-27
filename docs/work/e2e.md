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

## Doing (27 Sep, after logout 6)

- Merged main 68463d04 into work/e2e (changelog union).
- RC GATE PASS on ci's release-dry-run-v0.1.0-rc.1 (run 36342106246, work/ci-rc 1d8ae652):
  SHA256SUMS OK, build.json 0.1.0-rc.1 @ 1d8ae652 clean. rc-smoke 21 pass / 0 fail / 3 skip
  (phone enrol needs a tailnet; mail and appearance.tokens not in the build). Update 0.1.1 and
  rollback both keep the vault. Nothing left on testbox.
- box-deploy ran rc-smoke on main 68463d04's tgz (~/vyre-release-68463d0) at 18:57 UTC; it exited
  within a minute and cleaned up. Output (from box-deploy): 21 pass / 0 fail / 3 skip, all 8
  phases. Under a minute is normal with a warm docker cache (my rc.1 run took about as long).
  box-deploy had already redeployed the live box to 68463d04 before the gate result reached it.
- node RED on main 68463d04 (run 36341827061): 0 fail. journey.test.js:221 is the marked todo; the
  exit 1 is tmp-guard catching test/onboard.test.js (reserve/ts.net test) leaving a config.json.
  Verdict sent: known, deploy OK; the leak is the integrator's.
- Review teammates f8cbc882 (core/team, ADR 0031 step 1): NOT signed off. HIGH: person label
  "cli" is a free claim on the main socket (fromClaude only for PERSON_ONLY), so a session's Bash
  passes team.notes set / cancel / status / ask-with-project; team.notes `part` path traversal
  (any .md, e.g. project CLAUDE.md); result wrapper breakout into the requester's user turn.
  MEDIUM: projectOf falls to input when the thread has no project; team.list and notes get read
  across projects. LOW: MAX_VIA off by one; thread.finished subscribed after launch. Lead asked:
  daemon-wide downgrade of person labels that fromClaude catches. Waiting on their fix sha.
- Person-label downgrade (lead's call): work/e2e-label 1941f2cf off pre/rc 0c13e284. A person
  label (cli/local/deck/capsule) from under a claude or a thread becomes "mcp" (or
  "mcp:thread:<id>") for every tool and stream; person-only tools still refused. RC BLOCKER (pre/rc:
  settings secrets clear to a session's Bash, rules floor, vault generate checks, link/files lists).
  260/0/1 targeted + 69/69 hygiene/docs on testbox; sent to the integrator. Tests that call as
  "cli" must not run under a claude now.
- teammates round 2 (cbde18cc): HIGH 2/3, MEDIUMs, LOWs fixed. HIGH 1 fix rejected: team.ask/list/
  status/cancel/notes in PERSON_ONLY breaks thread-socket calls (threadsock 403), the Harness floor
  (MODEL_NEVER) and owner-device reads. Asked: keep only team.add + team.notes.edit, merge 1941f2cf,
  keep bareforge tests, add a spawner-on test. Sign off on that sha.
- vault-next a1a4e0b8 (9b connections) + connectors 8be461a9: NOT signed off. HIGH (probe on
  testbox, appended to connections.test.js boot()): module:planner registers items:[postbox's
  item] + use planner.add; the person's vault row is deleted, planner's row auto-granted
  capsule+chat, chat's send_mail pick routes to planner.add. MEDIUM: mcp revokes any surface;
  tailnet counts as person in allowed() without meta.person. LOW: "mobile" label claimable.
  connectors 8be461a9 OK (1-line label change since 84f630c9). Rerun the probe on vault's fix sha.
- teammates round 3 (49d2bd4d, tested with 1941f2cf's daemon applied): HIGH 2/3 OK; forged notes
  refused. OPEN: forged `team.ask` with another project got queued (after the downgrade a bare
  "mcp" with no thread/agent still passes projectOf's input.project). Asked: input.project only
  for PERSON callers + probe test. Their priority test races (subagent-slow never matches a
  wrapped prompt); my fix's +15 ms per cli socket call (perl peer-pid; 5.4 vs 20.5 ms/call on
  testbox, cached per keep-alive connection) exposes it.
- rc.2 follow-up (lead): work/e2e-surfaces c7dfcd26 (on 1941f2cf, worktree ../vyre-e2e-label).
  SURFACE_LABELS in core/modules (cli, local, deck, capsule, mobile); vyred downgrades ANY non-model
  label (not mcp/harness/anonymous) from under a claude. REBASED on main 476fe5fc (rc.1 at
  ac60d3c5) as 5a646023: 193/193 on testbox, sent to the integrator for rc.2. box-deploy told to
  run rc-smoke from acfef955 (scripts unchanged since 88610b5e) for the rc.1 redeploy.
  Note: local `main` in the shared repo lags; rebase onto origin/main.
- cohesion f3977466 (sight.watch agentCaller): OK, sight+waiting 23/23. Asked: same guard on
  sight.frame (proxies hands-desktop.screenshot as module:sight; hands-desktop resolveAgent only
  knows mcp:agent:). Offered lead a kernel fix: vouch agent claims only after mcp:/harness:
  ("cli:agent:kit" with a key passes person callers lists). Waiting on both.
- Agent-claim hardening (lead OK): work/e2e-agentclaim 1ff45c03 (on 5a646023). Socket labels name
  an agent only as mcp:agent:/harness:agent:; others 403 before the key check. No producer of other
  forms (MCP server, hooks, CLI, Capsule, Deck, app, fake-claude checked). 402/0/13 on testbox;
  sent to the integrator for rc.2. Worktree ../vyre-e2e-label (branches e2e-label, e2e-surfaces,
  e2e-agentclaim).
- rc.1 ac60d3c5 GATE FAIL (box-deploy's rc-smoke, confirmed): vyred never up; module.js imports
  packages/module-sdk/manifest.js, not in package.json files (platform a79d58f1). Deploy held;
  rerun on the fixed tgz. cohesion 4b9c0c0d SIGNED OFF (sight.watch + sight.frame guarded).
  Slip: started one sight run at load 7.3 (rule: under 6); check uptime first.
- rc.1 hotfix a3a844e4: GATE PASS 22/0/2 (theme on now; skips phone enrol, mail). Built on testbox:
  clone at the sha, build-app.sh, build-site.sh -> ~/vyre-ci/e2e-rc1h/site/box/vyre.tgz. box-deploy
  cleared to redeploy.
- a3a844e4 CONTESTED: box-deploy's 2 runs failed (step 3 onboard "vyred not running" right after
  step 2 passed; vault item gone across update), mine pass 22/0/2 on both tgz (theirs
  ~/vyre-release-a3a844e/vyre.tgz 8d5192ce has 3 Mac capsule bins extra; scripts identical).
  Suspect vyred restarting under the spawner (loop.sh logs "vyred exited (N); starting it again"
  to docker logs) and the vault losing items. Asked box-deploy for invocation, env, overlap, and
  one RC_KEEP=1 failing container. Lead told to hold the redeploy.
- a3a844e4 flake DIAGNOSED: stale vyred.lock after a container replace (same boot; old vyred pid
  reused by a /opt/vyre process: setpriv/sh/spawner) -> "already running (pid 15)", loop 2 s gap,
  calls in the gap fail. Seen in both kept containers. Fix work/e2e-ensureup 588995b4 (lock
  records process start time; ensureUp waits under VYRE_SUPERVISOR=docker), sent to the
  integrator. rc-smoke b3b1ab99: ready = same pid 3 s apart; new check that the loop never had to
  restart vyred (23/0/2). A/B could not force the collision (pid timing); the unit test covers it.
  box-deploy's 2 alone reruns on its a3a844e4 tgz with b3b1ab99: 23/0/2 both. CLOSED. The flaky step 3 in their runs is not fully explained yet.
  Slip: a merge left conflict markers in CHANGELOG (fixed in 850473f5: main's copy).
- Flake diagnosis DONE: reproduced with box-deploy's tree+tgz and the new rc-smoke (1 of 2: stale
  lock pid 22). "vault item gone" = never written (step 3 hit the gap), no data loss. Build diff
  (Mac capsule bins) inert; suggest ci excludes local/capsule/bin. Live box on a3a844e4 (my tgz),
  backup /srv/vyre-backups/2026-09-28-2.
- memory-iq: memory.correct {answer} OK; phone only with meta.person (same for graph). Session-sync
  ADR OK with conditions (machine from link peer, box-side switch, trust=min, scrub, provenance for
  delete, backups note). Review federation's transport when built.
- federation 0f2a8752: OK once MEDIUM fixed (Mac fails open when threads.asks errors). LOW: box
  treats unknown asks as ungated; nonces in memory.
- memory-iq 5f36a227 SIGNED OFF (one person rule for all corrections; ADR 0008 item 6).
- federation f712e7d7: fail-closed code CONFIRMED by reading it (mac.js answer, gatedOnMac). NOT
  signed off as a sha: it carries 0c645473 files.deliver. MEDIUM: every Mac runs `tailscale file
  get --loop` into ~/Vyre/inbox (takes over Taildrop); make it opt-in. LOW: callers "module".
  Lead's rule: security sign-offs need a read of the diff, every commit in the sha.
  e8302dce (nonces persisted, read: OK). aa9cb40c: files.receive opt-in, no module caller (read). BRANCH SIGNED OFF at aa9cb40c.
- memory-iq f49f7b02 (agent corrections from the person's words, 0.1.1): read; NOT signed off.
  HIGH: heard() is word containment only (any "not" = wrong/forget; value words anywhere = replace)
  -> need target words, freshness (latest turn / 10 min), per-turn and per-thread caps. MEDIUM:
  suggestion caps, plain() on accept, visible Undo row. Answered: threads.said by:"person" must
  exclude tool_result, isMeta, isSidechain, hook/skill/command text, ! output, inbox posts, non-
  person sends; internal only. Suggestions expire (14 d or when the fact changes).
- memory-iq e1851941 SIGNED OFF (HIGH fixed; read). LOWs before threads.said: empty about fails open,
  substring matching, heard-row race; "?" turns. Not reviewed: 034a4397, 398f6156, df22ca0c
  (memory.today in every brief = injection path; asked for a separate review), b7b0b9f0.
- vault-next f3d39f3f SIGNED OFF (read 4551a530, f3d39f3f, merge 5747b8b0 resolutions; takeover
  probe passes on testbox with mail.send as the foreign tool). LOWs: allowed() has no person flag;
  modules.tools(caller) added to the kernel ctx.
- teammates b19f10c2 SIGNED OFF (read: projectOf input.project only for PERSON callers; subagent
  match anywhere). Their switchboard.test.js "hang" with 1941f2cf: 57/57 green on testbox in 48 s
  on b19f10c2; likely run on the Mac under Claude (cli -> mcp, SSE waits). Asked where; idea:
  make such tests fail fast rather than hang.
- Switchboard hang (lead asked first): NOT reproduced. switchboard.test.js alone on testbox: 47/47
  in 41 s at main a3a844e4 and pre/rc a79851dc; 47/47 under a fake claude parent. Mac peer check
  ~27 ms per connection (peerPid 3 ms + ps ancestry 24 ms). Asked teammates for machine, command,
  output. Not an rc.2 blocker. CLOSED: teammates confirmed they ran it on the Mac inside Claude Code.
  Follow-up: 45/45 on testbox (teammates); Mac hang reverts with the daemon file. Unexplained on
  Mac (in-process calls should not downgrade); asked lead for one Mac run (plain Terminal + Capsule-style stream).
- memory-iq rc.2 58397f56 (source trust, read): OK after MEDIUM: header (session name, folder)
  counts as evidence on the personal paths -> drop it there. LOW: trusted() fails open on missing
  rows; sources lack role. f199928d LOWs on agent corrections confirmed (read). memory.today next.
- memory.today (read df22ca0c + 3d08288a; f03e2a3a does not exist): OK for 0.1.1 after MEDIUM:
  evidence must hold in userWords (pasted blocks) + trust row + not devTalk/Vyre folder (answered
  yes). LOW: last-session line uses the Claude-written name.
- teammates be21345a (steps 2/3, read): threadRecord fix and release-on-finished good. MEDIUM:
  rotation puts notes + last results raw into the SYSTEM append -> move to first prompt, fenced,
  neutralized, capped. LOW: thread.finished can fire during launch's awaits -> stuck slot.
- memory-iq-rc2 aaf4fcb5 SIGNED OFF for rc.2 (header not evidence on personal paths; human === 1; roles on sources). Last e2e item for rc.2.
- MAC CHECK (lead OK, 28 Sep): probe under Claude: in-process and child calls keep cli/capsule (vyred's
  own ancestors are excluded) -> lead's hypothesis false. switchboard.test.js DETACHED (double fork,
  PPID 1) still hangs on the Mac at the first vyred+stream test; stopped at 3 min; passes on testbox;
  reverting core/daemon/index.js fixes it (teammates). Suspect per-connection peer check on macOS
  (perl LOCAL_PEERPID or ps -A). rc.1 carries it; the Capsule's stream goes through it. Asked lead for
  one instrumented Mac run. Orphan teammates run pid 30878 on the Mac (not mine). Scratch: maccheck/.
- memory-iq 11b9147f (memory.today fixes) SIGNED OFF for 0.1.1 (read). Import design (8702ab66): notes
  sent (scan caps, plan-hash consent, cancel = revoke, scrub+quarantine, machine on every row, no agent).
- federation transport design (8d982f85): dedicated tailnet upload route (paired node only, chunk cap,
  resume keyed by machine, box switch); device role = capability-limited peer kind, not a 2nd identity.
- glass-live 14f1824c SIGNED OFF (read with a sonnet helper, key lines verified). MEDIUM latent: cdpmux
  target discovery isn't per-session in Chrome; safe only because agent and fill never connect at
  once. LOW: shield in memory, a restart unshields.
- MAC HANG NAMED + FIXED (rc.2 blocker): peer check spawns perl with vyred's socket as fd 3; on macOS
  libuv clears O_NONBLOCK for the child and the flag is shared -> vyred's socket blocks; a large write
  (tool list, a stream) stalls vyred, deadlocks in-process. Proved: nb.mjs BLOCKING on Mac, nonblock on
  Linux. Fix work/e2e-peerfix a8eee5dc (off pre/rc 1190db28): perl restores O_NONBLOCK first; an
  unreadable peer (where peers are readable) fails closed. Mac detached 56/56 in 10 s (hung before);
  the new test fails on old code; testbox 223/223. Sent to the integrator. Worktree ../vyre-e2e-peerfix.
- launch journey.test at 359e3428: green on testbox (7/0/1 skip/1 todo); not real.
- Reviewer (second, Opus) owns: windows, teammates 20d0f121, memory-iq d0b916b9. I keep federation
  transport, vault designs, import. glass 14f1824c already signed off by me.
- peerfix ae9c6cdc (reviewer MEDIUMs): /usr/bin/perl + env {}; parent setBlocking(false) on close/
  error; SIGKILL timeout. Tests for both (the restore test fails on the Mac without it). Mac detached
  58/58, testbox 228/228. Sent to reviewer for confirmation, then the integrator.
- glass 14f1824c: reviewer's HIGH 1 (DOM.setFileInputFiles / drag files read .boot via Chrome as
  uid 1001) is valid; I missed it. My sign-off withdrawn for rc.2; reviewer owns glass now.
- Queue: connectors 21beb66b (0.1.1 batch 1) review; later: agent-browser sizing on testbox.
- connectors 21beb66b SIGNED OFF for 0.1.1 batch 1 (read: kernel merge firstParty after ...meta; lib move
  pure renames; discover.js read-only). Before wiring discover: strip env/header values (names only),
  userHome via a claudeJson(root) kernel rule, cwd from the verified project.
- peerfix ae9c6cdc SIGNED OFF by reviewer; integrator told to land ae9c6cdc. ps -A replacement -> 0.1.1.
- Waiting: glass hotfix sha (read full diff as second pair of eyes); federation transport code.
- 0.1.1 queue (after rc.2): agent-browser sizing on testbox; browse eval harness (~30 fixture tasks,
  CI gate, 90%) once glass's browse.task exists; per-level peer lookup instead of ps -A.
- cohesion 5ef364c3 (shared agentClaim, read): real gaps closed; MEDIUM regression: empty name ("cli agent:")
  returns "" -> falsy -> network/relay now trust it (they denied before). Asked: empty counts as a claim.
  TODO me: fold core/daemon's AGENT_CLAIM into agentClaim after 1ff45c03 lands.
Next: rerun rc-smoke on each new RC dry run (mail/theme steps switch on once vault-next, connectors
and appearance land); review vault 9b before it lands with connectors; any review sent to me.

## RESTART SAVE (27 Sep, before the restart)

Handed off (all with the integrator or signed off):
- work/e2e-sdk 65cbc02a (image SDK pin) landed. work/e2e-noclaude 88c90d56 (claudeHome,
  transcriptFolders, learn skills, switchboard remember) sent to the integrator.
- work/e2e 4e5a27f7-era code (404 not_found, `vyre link signin` waits) for batch 4; scripts:
  e2e-split/thread.sh, e2e-headscale README, rc-smoke.sh (+ scripts/rc-smoke/) at daf63e22.
- Signed off: native-core 3ae4fc93 and fa349d31 (+ platform d62792d0, 70242656), connectors
  84f630c9, cohesion 533f84e2 / RC 0f4d1105, sessions db4af9c3 (split validated: check.sh 30/30,
  thread.sh 8/8), memory-iq 6a49c4bb (+ transcriptFolders merged in 2dd6e83a).
- rc-smoke proven: 21 pass / 0 fail / 3 skip on a build-app + npm pack of pre/batch4b 63d943f5.
  box-deploy runs it from work/e2e 88610b5e on main 68463d04's build-site vyre.tgz (npm ci first).

Waiting on:
- box-deploy's rc-smoke output on 68463d04 (mail/theme may switch on there).
- ci's release-dry-run-v0.1.0-rc.1 artifact: `gh run download <id> -R vyre-ai/vyre -n
  release-dry-run-v0.1.0-rc.1 -D <dir>`, check SHA256SUMS, run rc-smoke on it.
- The integrator's reply on core/memory/rooms.test.js:227 (passes alone; likely run under claude).

Next after the restart: merge main into work/e2e; the two above; any review a team sends.
No testbox processes of mine are running.

## Doing (27 Sep, after logout 4)

Done this session:
- Merged main 7880dfa6 into work/e2e (0856b9b9; changelog union, generated docs regenerated).
- The candidate image did not build: box/Dockerfile imports core/sessions/sdk.js on its own to read
  the SDK pin, and 8aed4887 gave it an import. Fixed in work/e2e-sdk 65cbc02a (pin in
  core/sessions/sdk-pin.js, imports nothing; test on the Dockerfile's COPY line). Sent to the
  integrator, box-deploy and the lead.
- Headscale gate on main + 65cbc02a: PASS, 16 items (list sent to box-deploy). Glass not rerun.
  Low: unknown ids at gate.get/agents.delete answer 500, not 404; `vyre link signin` prints nothing
  on success. Harness: the image needs a build.json stamp, or the Deck's service worker keeps the
  last run's files (same "v0.0.1" cache name) and the passkey page breaks on a stale api.js.
- rooms.test.js:227 passes alone on testbox; asked the integrator for the failing text (likely a
  run under a `claude` process, since agents.create is PERSON_ONLY on the socket).
- Batch 4 sha sent: work/e2e 4e5a27f7 (was 0856b9b9).
- native-core re-review of 62abf2cf (tip 87fb03d7): HIGH 1 and 2 fixed, store limits right, 60/60
  on testbox. NOT signed off: new HIGH, settings.get has no callers, so mcp and agents read
  sessions.env values (Claude Code's env, API keys). Asked for masked values for non-person
  callers plus a test. MEDIUMs sent: firstParty = "under the repo" (dev home in a checkout),
  env/plugins/deny-removal without confirm, asPerson's "deck" fallback. SIGNED OFF at 3ae4fc93
  (env and hooks secret, masked for non-person callers; 63/63). MEDIUMs are theirs before 0.1.0.

~/.claude from a temp home (lead, 27 Sep): platform saw a fresh temp home report "107 facts about
you". recall's readable() guards only under node --test, so a dev world read the real transcripts
(config default, core/config/index.js:135). Guard test on work/e2e-noclaude (52ac6576 + the next
commit): vyred in a child with HOME = a planted fake home, NODE_TEST_CONTEXT cleared, every fs call on
a .claude path recorded and refused. Red on main with exactly those 3 paths. FIXED by me (lead's call): claudeHome() in core/config, work/e2e-noclaude 32dc0956, guard
green, sent to the integrator. memory-iq keeps its recall-side fix (I review it). One-line switches sent to sessions,
polish-cli, native-core; learn done by me (lead OK): 399ca89f; the skills write guard keeps refusing the real ~/.claude too. Branch sent at 399ca89f. Other defaults to route through one kernel helper:
learn/skills.js:414, switchboard/index.js:1333, cli statusline.js:22, native-core settings claudeDir.

Reviews (27 Sep, testbox on hold at load 20 per the lead):
- memory-iq 6a49c4bb (recall readable): OK. MEDIUM: realpath both sides (symlinks); the switchboard
  reads config.transcripts unfiltered (index.js:1554), offered to move readable() into core/config.
- cohesion c362505b (hands): nothing typed reaches events. MEDIUM scrub() bypass (quote or space in
  a model URL keeps the query; build open's summary from new URL()); MEDIUM desktop takes
  input.thread when meta has none. Chrome e2e needs a Mac slot from the lead.
- connectors 04a5495e: HIGH any module (home ones too) passes on_behalf {surface:"capsule"} to mail
  and reads mail as the Capsule; asked for registry meta.firstParty. MEDIUM on_behalf person=true
  skips MCP scope; check on_behalf.thread against threads.get.
- e2e-noclaude bf35f8ea: switchboard remember's user CLAUDE.md via claudeHome (sessions agreed).
  TESTED 147 pass / 0 fail / 28 skip; sent to the integrator as the sha to land.
Next when testbox is free: that test run, then rebuild 501ca3fc (+ sessions' callAsPerson fix) and
run check.sh + thread.sh.

- native-core ac34c322: my 3 MEDIUMs fixed (98412a66). Hub step 1 OK; MEDIUM secret non-store keys
  would go to hub.json in clear (and backup); LOW same-uid edits of plain settings, file rev lags.

- transcriptFolders (lead OK, memory-iq agreed): core/config/dialogs.js, realpath both ways,
  switchboard reads through it; e2e-noclaude 88c90d56 green, sent to the integrator and memory-iq.
- cohesion: SIGNED OFF at 533f84e2 (agent-label nit fixed); Chromium e2e result still to come.
- connectors 7e648545: HIGH + MEDIUMs fixed, OK once tests run; build firstParty(name) on
  native-core's firstParty(dir).

RC SMOKE PROVEN: build-app.sh + npm pack of pre/batch4b 63d943f5 (build.json stamped): 21 pass,
0 fail, 3 skip (pairing, mail, theme). /app/ 200. Rerun on ci's rc.1 dry-run artifact later.
RC SMOKE (lead, 27 Sep): scripts/rc-smoke.sh <tgz> + scripts/rc-smoke/ (e62b0d22). Dry run on an
npm pack of pre/batch4b 63d943f5: 19 pass, 2 FAIL (/app/ no_app: npm pack has no built app; a
build-site tgz must pass), 3 skip (phone enrol needs a tailnet; mail and appearance not in b4).
Mail step written (daf63e22: vault.connect, made-up hosts, mail.send held; on with vault-next +
connectors). Next: ci sends the run id of release-dry-run-v0.1.0-rc.1 after batch 4 + the rc.1 bump;
`gh run download <id> -R vyre-ai/vyre -n release-dry-run-v0.1.0-rc.1 -D <dir>`, check SHA256SUMS, run rc-smoke.
Cleared: native-core fa349d31 + platform d62792d0; cohesion 0f4d1105 (Chromium 8/8).

SPLIT VALIDATED on sessions db4af9c3 (callAsPerson ed2715ae) + main 53cd1326: check.sh 30/30,
thread.sh 8/8; cleared to the integrator. MCP list 258 -> 239 (asked sessions to check the filter).
connectors SIGNED OFF at 84f630c9 (226/226 + docs 50/50); firstParty dup with native-core at merge.
memory-iq merged 88c90d56 (2dd6e83a).

Split with sessions 501ca3fc (lead, 27 Sep): image from 501ca3fc merged with main 53cd1326.
check.sh 30/30. New scripts/e2e-split/thread.sh (vyred starts a session through the spawner, CLI
runner, VYRE_CLAUDE_BIN = a stand-in in /work): 6/7. FAIL `vyre call` inside a session: callAsPerson
(core/cli/presence.js:47) pins root, so VYRE_SOCKET is ignored. Sent to sessions with the fix. Low:
MCP offers 258 tools incl. person-only. NOT yet cleared for the integrator; rerun both on their sha.

Batch 4 lows (lead, 27 Sep): DONE in 8b9b092c. Unknown ids at gate.* and agents.* answer 404
not_found; `vyre link signin` at a terminal waits on the event stream and says "signed in on the
box until <date>" (test/daemon.test.js, test/link-person.test.js; 115/115 + 88/88 on testbox).

Next, in order:
1. DONE (see above). To rerun the headscale gate on a new sha: Setup kept in
   /srv/vyre-e2e (CA, NSS db). Build `docker build -t vyre-e2e:local -f box/Dockerfile .` from that
   sha on testbox, then `./run1.sh`, `./run2.sh <link>`, `./run3.sh` (run3 uses `vyre up --connect`),
   then the person-session checks (curl from the Mac node gets 401; the Deck's first action signs in;
   `vyre link signin`; a claude-parented call and its orphan refused). A cloned passkey on the phone
   makes the Mac's counter go backwards: bump signCount or re-add. Tear down: `docker compose
   --profile mac --profile phone --profile computers down -v` in /srv/vyre-e2e; kill drive*.pid.
   Report pass/fail per item to box-deploy and the lead.
2. Re-review native-core when it sends a sha. Open: settings.set/reset into PERSON_ONLY and refuse
   agent labels (HIGH 1); module-declared stores: home modules only own tools as module:<name>, own
   config paths, no claude store, checked at load; CALL_AS scoped to core modules' declared setter
   tools (HIGH 2). platform's settings.write e4515fb6 is approved, lands after.
3. Batch 4: no auto-pair (9fc65458).
4. Per-thread socket with sessions: they wire VYRE_SOCKET in spawnSession and client.js, then flip
   sessions.spawner to "on"; rebuild the image and run scripts/e2e-split/check.sh (it now also checks
   /run/vyre-threads).
Also open: glass-live MEDIUMs (docs/work/glass-live.md); sessions' bypass checks (hook floor, refuse
bypass without the harness plugin); the phone's two identities (tailnet node vs relay device) is a
design item for the lead.

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

- core/daemon: on the socket an agent is named only as mcp:agent:<name> or harness:agent:<name>
  (1ff45c03). core/modules exports SURFACE_LABELS (5a646023).

- core/daemon: a socket caller's person label from under a claude or a thread is "mcp" (or
  "mcp:thread:<id>"), for every tool (work/e2e-label 1941f2cf).

- core/config: `claudeHome(root, env?)`: Claude Code's folder for a Vyre home (real ~/.claude or
  CLAUDE_CONFIG_DIR only for the real ~/.vyre; `<home>/claude` otherwise; VYRE_CLAUDE_HOME
  overrides). Default `transcripts` use it.

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
