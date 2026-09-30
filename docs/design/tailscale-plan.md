---
title: Tailscale plan
summary: Status of ADR 0014's ten parts, where more benefit is on the table, the simplest install, and what fits 0.1.1.
audience: builders
owner: tailnet
status: draft
---

# Tailscale plan

Written 28 Sep 2026 after merging origin/main (a3a844e4) into work/tailnet with no conflicts.

## 1. Status of the ten parts

All ten parts of ADR 0014 are merged to main (verified by content, not just SHA: each file's
landing commit is an ancestor of origin/main). The only unmerged commits on work/tailnet are two
doc-only updates (4fa25b16, 1d194c9f): safe to drop or fold in, no code.

| # | Part | On main | Notes |
|---|------|---------|-------|
| 1 | Taildrive | yes | Renamed "VyreDrive" in user-facing text (1498c4a2); read-only default, per-share rw switch, secret-scan on share |
| 2 | Taildrop | yes | The server stays a tagged node; inbox watcher via `file get --loop` |
| 3 | Tailscale SSH | yes | `vyre box add`/`move` prefer it, plain ssh fallback |
| 4 | Health | yes | `link.health`, server-only, module + owner; Glass paces relayed viewers |
| 5 | Exit node / egress | yes | `egressgate.js` fail-closed gate + sidecar; OAuth client secret for renewal |
| 6 | Tailnet Lock | yes | Read-only (`lock status`), onboarding card + Settings row; never writes |
| 7 | Grants (app capabilities) | yes | `vault.relay.grants`, `vault.grants.status`; narrows only, never widens |
| 8 | Guests | yes | `network` module; GUEST_SAFE is `threads.list` only as of the CORS/session work |
| 9 | Agent nodes | **redesigned, not built** | The user approved glass's shared-headless-Chrome-plus-desktop-pool design (agent-browsers.md) over a computer per agent. Part 9 changes with it: not a node per computer, but a userspace tailscaled sidecar per agent that has a tailnet grant, exposing a local SOCKS5 proxy that agent's browser context is pointed at. See "Agent nodes, redesigned" below. |
| 10 | Funnel / hooks | yes | `hooks` module, own listener on 127.0.0.1:7310, signature-verified, never calls a tool |

Adjacent, not mine: work/federation carries the Mac-session `threads.answer` v2 (signed server
assertion): still on its own branch, queued batch 4, not part of ADR 0014's ten.

## 2. Max benefit: where Tailscale can give Vyre more

| Idea | Value | Size | Admin step |
|---|---|---|---|
| Agent nodes, redesigned (see below) | Every agent with a grant gets its own tailnet identity for its browsing, without the per-computer image change part 9 used to need | M | none new (tag already defined) |
| MagicDNS name shown everywhere the server's address appears (onboarding, Settings, `vyre box add` suggestion) | One name to remember instead of an IP; nothing new to build, mostly surfacing what `tailscale cert`'s target already is | S | Enable MagicDNS (usually on by default) |
| Device posture as a second gate on vault relay grants (`vault.relay.grants`) and egress | A stolen laptop stays off even with valid Tailscale login | M | Posture policy in admin console (needs a device posture add-on, paid tier) |
| Tags per device role, generated ACL snippet Vyre hands the person to paste (see section 3) | Cuts hand-editing the policy JSON to near zero | S | Paste once |
| Serve (internal HTTPS, not just Funnel) for a second local service (e.g. a future web UI on another port) if one shows up | Avoids a second cert/port dance | S | none, `tailscale serve` is user-run only |
| App connectors | Low fit, Vyre reaches the server, not a fleet of internal SaaS subnets; skip unless a company-tailnet use case appears | n/a | n/a |

Nothing here needs a new Vyre-side mechanism except finishing part 9; the rest is packaging what
exists more clearly for the person.

## 3. Simplest install

Current: onboarding step 3 (`tailscale`, after `you` and `claude`, in `core/onboard/index.js:19`)
calls `names.connect`, gets a login URL, and `poll`s until whois shows Running. That's already
one link, no separate account creation. What adds friction today:

- The person still writes tailnet policy JSON by hand for Taildrive, Taildrop's grant, SSH, and
  egress (all under "Steps for the user" in docs/adr/0014-tailnet.md): four separate snippets,
  merged manually into one file, none of it Vyre-editable per ADR 0014 rule 1.
- No single generated snippet: each feature's snippet is documented separately, so turning on
  Taildrive today and egress next week means two trips to the admin console with two pastes.

Proposal for 0.1.1: `onboard.tailscale { action: "policy" }` returns one JSON object merging
whatever the person has turned on so far (Taildrive on → add its nodeAttrs/grant; SSH always
included since `vyre box add` needs it): a single paste, not four. Still generates only; Vyre
never calls the ACL API. This is a small addition to `core/onboard/index.js`, reusing what each
part's snippet already is.

OAuth client vs. auth key: today's step 3 is the interactive login link (best for a first
device); egress and agent nodes need a reusable key/OAuth secret, entered later in
`/srv/vyre/.env` by hand. No change proposed there: that's an admin secret, not onboarding.

Windows/Mac difference: unexamined in this pass, worth one of launch's or windows' team a look,
since `tailscale set --ssh` and MagicDNS behavior differ slightly there.

## 4. 0.1.1 vs later

**Fits 0.1.1** (small, no new admin burden):
- Fold the two open docs commits into main, close out work/tailnet.
- MagicDNS name surfaced in onboarding/Settings/`box add` suggestions.
- The merged-policy-snippet tool (`onboard.tailscale { action: "policy" }`).

**Later, needs a decision first:**
- Part 9 image change (root-then-`setpriv` on port 7001): Decision 4, open since 27 Sep, amends
  ADR 0009. Blocks real per-agent tailnet identity.
- Device posture gate: needs to know if the person's plan includes the posture add-on before
  building against it.
- Guest `threads.get` and per-route webhook secrets: Decisions 6 and 7 in the ADR, still open.

## Decisions for the lead

1. Build part 9's image change now, or leave agent nodes off for 0.1.1? (Blocks nothing else.)
2. Worth building the merged-policy-snippet tool for 0.1.1, or is four separate snippets fine
   given install already happens once per person?
3. Any appetite for device posture (paid Tailscale tier) as a gate on vault relay/egress?
