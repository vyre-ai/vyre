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
| 10 | Passkey, Deck, Chat, Agents, Vault and Mac pairing cannot be checked without a real tailnet login (by design, ADR 0002). Checking them needs a tagged, ephemeral auth key for a throwaway node | lead (a decision) |
| 11 | local/capsule changed since the live Capsule zip (2e795b8 vs 16613ae), so the next release.sh rebuilds and uploads Vyre-mac.zip | lead, at release |

## Doing (27 Sep, headscale run)

A private tailnet on the test box: /srv/vyre-e2e (compose project vyre-e2e, label run.vyre.e2e) runs
headscale 0.26.1, the box (image vyre-e2e:local built from this branch), a stand-in Mac node
(alex-mac: tailscale + headless Chrome + a role-local vyred) and a phone node (alex-phone). A
throwaway CA; its cert is trusted only in the e2e Chrome profile's NSS db and in the Mac vyred
(NODE_EXTRA_CA_CERTS). A test-only shim (VYRE_TAILSCALE_BIN) answers `tailscale cert` from that CA
and adds CertDomains, since headscale has neither. Scripts there: run1.sh (up to the link),
run2.sh <link> (onboarding to the Deck), drive.mjs (CDP driver on 127.0.0.1:19300).

Works end to end: loopback onboarding, Tailscale sign-in (the page shows headscale's link from
AuthURL), ts.net address, first passkey at the address (virtual authenticator), Deck pages, a
Vault item sealed with passkey presence, `vyre up` on the Mac finding the box (link.find).

Fixed here: 1a7dd2c, the box's Deck (caller tailnet:<owner>) was refused by every tool whose
callers list names deck: gate.get/approve/reject, push.*, agents.delete, vault.update.

Next: pair the Mac (approve from the phone node with a synced passkey), tailnet first-run checks,
tear down (`docker compose --profile mac --profile phone down -v`, rm -rf /srv/vyre-e2e, docker
rmi vyre-e2e:local).

## Needs from others

- The lead: whether to use a throwaway tailnet node for the checks after Tailscale (snag 10).

## Changed contracts

None.
