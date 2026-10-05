---
title: Security
summary: The security model in one page: the floor that cannot be switched off, how the vault seals values, who can reach the box, how agents' containers are locked down, and how to report a problem.
audience: operators, builders, users
owner: integrator
status: stable
---

# Security

Vyre runs Claude Code, and agents, on a machine you own, with your credentials within reach. The model rests on four things: a floor of rules enforced outside the model, a vault that keeps values off every screen, a network that only your own devices can reach, and containers for agents that cannot become root on the box. Each has a decision record with the full threat model; this page is the summary and the index.

## The floor

Nine rules, enforced by the Harness's Rules hook, the same rules in `vyred` for every tool call that is not you at your own surface (an agent, a module, MCP, a device that reaches the box), presence checks in `vyred`, the Gate and the event log, not by asking the model. None can be configured away. The one that matters most for credentials is rule 8: no vault value appears on any screen, log or event, except to a person who has just proved presence on their own device, for that one value. Never to a model, an agent, a log or an event.

Read them all, with what each means in practice, in [The security floor](../concepts/floor.md). The source is [Section 11 of the spec](../architecture/spec.md#11-the-security-floor).

Presence is how Vyre knows a person, not a process, is asking: a passkey or Touch ID check, made by `vyred`, before a human-only action such as revealing a value. A device identity is not presence. See [Presence](../concepts/presence.md) and [ADR 0004](../adr/0004-presence.md).

## The vault

- **Only `node:crypto`.** AES-256-GCM, HKDF-SHA256, HMAC-SHA256, Argon2id (scrypt where Node has no Argon2id), Ed25519 and X25519. No dependency can read what the vault encrypts.
- **A device key, kept out of the data folder.** On a Mac it is in the login keychain, written by a small helper that is the only app allowed to read it (only for the real `~/.vyre`). On Linux it is `vault/key`, mode 0600, owned by the account `vyred` runs as. With the `passphrase` keystore it is nowhere at rest: it is wrapped by a key derived from your passphrase, and the vault stays locked until `vyre vault unlock`.
- **Two vaults.** The device key opens the agents' vault, which holds what agents and modules may be granted. Your personal vault, once you create an account (`vyre vault account create`), opens only with your password and Secret Key, or with Touch ID on a Mac you enrolled. The device key alone does not open it.
- **A key per item version.** Each item version is sealed under its own random key, which is wrapped under its vault's key. The vault, the item's id, its version and its name are bound into the authenticated data, and each row in `vyre.db` carries an HMAC, so a sealed file moved into another slot, or an older version put back, fails to open.
- **Names are listable, values are sealed.** The store holds names, kinds, field names and hosts. Every field value is in `vault/items/`, which the Rules deny to any tool.
- **Release by grant.** A module gets a value only with a grant for exactly that module. When Claude asks for a grant or a pass, it waits as pending until you run `vyre vault approve <id>`.
- **Sharing without handing over.** A pass is relayed by default: the other person's calls go through your box, which adds the credential on the way out, bound to the hosts it may be sent to. Revoking ends access at once. `vyre vault offboard <person>` revokes everything a person holds and lists the sealed items to rotate.

What it does not defend, stated plainly in the ADR: code running as the `vyred` user can read the key the same way `vyred` does; a module you granted an item to is trusted with it; and a process started by `vyre vault run` receives the values in its environment by design (its output is scrubbed of them, which stops accidents, not a determined program).

Details: [ADR 0001](../adr/0001-vault-crypto.md), the key hierarchy in [ADR 0006](../adr/0006-vault-next.md), and autofill in [ADR 0010](../adr/0010-vault-autofill.md). How to use it: [The vault](../using/vault.md).

## Network and identity

- **Only your devices reach the box.** The built-in private network and the relay carry every connection, and the only port a Docker box publishes to the host is 7300, on `127.0.0.1`, for onboarding.
- **Callers are identified from your identity list,** never by a header. A device that reaches the box arrives as `device:<id>`, and the entry on the list says who it is, so a process that sets its own headers cannot pose as you.
- **Owners and roles.** A space has owners, and a role decides what each person may do: owner, admin, manager, member or temp.
- **Onboarding is loopback only.** Before an owner exists, `vyred` serves one route: the onboarding page, on loopback, behind a one-time token that expires after an hour. It checks the `Host` header, so a page on another site cannot reach it through DNS rebinding.
- **No root.** `vyred` runs as uid 1000 in the container, or as your own login account without Docker, never root.
- **A Mac pairs only with your passkey.** Approving a pairing needs presence, and the box refuses the approval from the Mac that asks, since a model on that Mac can read the code it shows.
- **The box reads six things from the Mac, and nothing else.** The paired Mac holds one request open to the box, so the Mac opens no port. Six read tools cross (projects, recall and thread lists), checked against the same list on both ends, only for you and never for an agent, MCP or a guest. Nothing the Mac answers is stored on the box ([ADR 0021](../adr/0021-box-reads-the-mac.md)).
- **Vyre keeps nothing about you on its own servers.** The one public trace is the DNS record of a `vyre.run` name, if you claim one: the name and your box's address on the private network, which nothing off your network can reach. (Claude Code talks to its own services as it always does.)

Details: [ADR 0002](../adr/0002-network-and-identity.md), [Your private network](../concepts/network.md).

## Agents' computers

An agent's computer is a Docker container. The Docker socket is root on the host, so `vyred` never touches it. The `docker-api` service (`core/dockerproxy`, on only with `COMPOSE_PROFILES=computers`) holds the socket and allows only the calls agents' computers use. It checks request bodies too, with the same policy (`core/computers/driver/policy.js`) that builds them:

- `Privileged` is never true, and nothing is bind-mounted: the only mount is the agent's own named volume at `/home/agent`.
- Never the host network or process namespace.
- `CapDrop: ["ALL"]`, no host devices, a read-only root filesystem with small tmpfs mounts, `no-new-privileges`, and Docker's default seccomp profile.
- Every container and volume is labelled, and every per-container call is checked against the labels the Docker Engine itself reports.

One residual is known and recorded: labels tell an agent's computer apart from everything else on the box, but not from another agent's computer, so a caller that reaches the proxy directly can act on any agent's computer. Closing it needs Claude's own sessions to run in a separate container, off that network. That container is not built yet.

Chrome's debugging port inside a computer is never exposed without authentication ([ADR 0012](../adr/0012-cdp-proxy.md)). Details: [ADR 0009](../adr/0009-container-hardening.md), and Glass's stream in [ADR 0003](../adr/0003-glass-stream.md).

## Vyre for Chrome: what a script run in your page can reach

`chrome_eval` runs an agent's script in a page where you are signed in. Unless you approved it, the script can read but not send anything out. The network rules hold for the whole run:

- **The browser enforces the limit.** A rule for the tab blocks every request type except the page's own navigation, and allows only exact origins (scheme, host and port): the page's own, and origins that already gave the page a completed response. A second rule covers requests that belong to no tab (shared and service workers), scoped by the page's host. Vyre reads the rules back, and where Chrome allows it test-matches an image and an XHR to a fresh origin, before the script runs. If it cannot confirm them, the script does not run.
- **Workers rest on the browser rule alone.** Chrome has no Fetch interception on a dedicated worker, so a worker's requests are stopped by the DNR rules and nothing else; a real-Chrome test with Fetch switched off shows zero requests reaching a fresh origin from a Blob worker, a shared worker, an image and a beacon.
- **What a script leaves running after the call returns is still judged.** Until the page navigates its main frame, Fetch stays on for the tab: a request whose initiator stack names the call's own script (a timer, a promise chain, an event handler it added; handlers and functions written in the script, and code the script builds from a string with eval, `new Function` or a string timer, which the guard tags through the Debugger domain by the script that created it) is judged against the allowed set as it stood when the call returned, and a frame the script made stays judged on its own session. A worker the script made is closed when the call returns, because Chrome offers no Fetch interception on a dedicated worker and the browser rules cannot tell a worker's request from the page's. The cost is that the Debugger domain stays on for the page's life (it is turned on again at every guard start, so a re-attach does not lose it), with pauses skipped, and every request of that tab pauses and is continued (about a millisecond each) until the page navigates. Not held: a Blob worker that attaches after the call returned on a Chrome where workers have no Fetch (it is judged only where they do), and a request Chrome does not tie to the script by its initiator stack.
- **Workers have no size cap.** The 256-byte limit and the third-party budget live in the Fetch layer, which a worker does not have. A worker the script starts is stopped by the browser rules and can send any amount to an origin on the allow list. Workers also cannot be started from the page's own code under the guard, and one Vyre cannot guard is emptied while it still waits for the debugger, or left paused.
- **A frame Vyre cannot guard** is emptied (`location.replace` to a blank page) while it still waits for the debugger, then resumed. That navigation is asynchronous, so the frame's first script can run for a few milliseconds after the resume; the browser rules, kept up for 400 ms after the release, cover those milliseconds.
- **New WebSockets** are allowed only to the page's own host (and the host of the frame the script runs in). A script's new socket to a third party is refused while the guard is up; a socket the page already holds is untouched.
- **A page with a service worker has no Fetch layer.** A worker's own network is invisible to Fetch, so on such a page the browser rules stand alone, and for the guard's window they allow the page's own origin only: its third-party requests are dropped during the script, which closes the unbounded-send channel. Vyre refuses the script where it cannot test those rules (a packed extension has no `testMatchOutcome`). Whether a frame has a worker is read from an isolated world where Chrome allows it (a page cannot redefine what that world sees) and otherwise taken from the page's own claim; a false claim only makes the rules stricter. If Vyre ever ships as a packed extension, `testMatchOutcome` is missing there and every page with a service worker would refuse scripts, so that day needs another proof.
- **A page's CSP** counts as covering a probe only when Chrome itself reports the probe blocked by it.
- **Every frame is watched too.** The Fetch domain is on in every frame and worker of the tab, new ones start paused, and a request to an origin outside the list is failed. Before the script runs, its own frame sends an image and a fetch to an unroutable host. Vyre waits for both to be intercepted, asks again once, and refuses the script if they are not.
- **The page's own code is a third layer.** Under the guard a script cannot start a worker, open a window, or set an image or media source on another origin.

Known residuals:
- **Third parties the page already uses** (analytics, chat widgets) stay reachable, but only for small requests: 256 bytes each, and 1 KB and 8 requests in total per script. A service many sites share can still receive up to that much.
- **An oversize request from the page itself** to such an origin is blocked. The origin stays allowed for later scripts.
- **Which origins count as already used** is seeded at the first guard from what Chrome reports as loaded and from the page's own resource-timing entries. Page script can rewrite those entries before Vyre first runs a script on that tab. Responses seen outside a guard are recorded by Chrome, not the page.
- **The guard's diagnostics** (what was allowed and why) never go back to the model. Only a test harness reads them.

## Vyre for Chrome: acting on a picture

`chrome_point` clicks, types, scrolls, hovers and drags at a point of a screenshot, for a surface with no controls in the page (a canvas, a video, a frame Vyre cannot read into). It is the last rung, and a new write path, so:

- **The point comes from the shot Vyre kept** (an unguessable id, 60 seconds), never from numbers in the call. The page must still match the picture: scroll, zoom, size, address and open dialogs are compared, and right before the click the same element must still be under the point.
- **What is under the point is read by its text**, through open shadow roots and into iframes: the node's own text, aria-label, title, alt and value, and those of its ancestors up to the nearest clickable. A Send, Delete, publish or payment holds for the person exactly as `chrome_act` would, even when drawn as a bare div, and no plan lifts that.
- **A target with no text at all** (a canvas, a video, a closed shadow root, a frame Vyre cannot see into) is a drawn surface. It waits for the person, unless the person approved a plan that names that kind of pointing (click, type, drag), for this tab and this origin. The plan card says plainly that Vyre cannot tell what a click on a drawn surface does. A click in a cross-origin frame is covered only when the plan names the frame's origin. A double click costs two.
- **Typing** refuses line breaks, tabs and control characters (Enter sends), refuses password and one-time-code fields, and refuses when the field that has focus cannot be read, unless a plan covers it.
- **A screenshot is refused** when any frame of the page shows a password or one-time-code field, and the automatic picture that comes with a failed call follows the same rule and the same floor.
- **Learned rungs are advisory.** The site record keeps, per page template, which rung of the ladder (API, controls, devtools, accessibility tree, picture) worked, as integers counted by the store. A page template that needed the picture before says so in the snapshot as a hint for where to start. It never skips a check: `chrome_point` holds and asks the same however the model got there, and a hostile page can at most make the picture the first thing tried.
- **Residual:** a plan that covers a drawn surface cannot see a painted "Send" button, so a click there goes through. That is the consent the plan asks for.

## Backups

`vyre backup` writes config, the store, the sealed vault, watchers, modules, certificates and names into one file, mode 0600. It contains the sealed vault. Keep it somewhere only you can read, or encrypt it. `vyre vault backup <file>` seals the whole vault to a passphrase of its own. See [Looking after the box](../using/box-care.md).

## Report a problem

If you find a security problem, report it privately to the maintainers. Do not open a public issue, and do not include a working exploit against someone else's box.

Email security@vyre.run. Include what you found, the commit or version (`vyre version`), and the steps to see it.

## Where to go next

- [The security floor](../concepts/floor.md)
- [The vault](../using/vault.md)
- [Architecture](../architecture/index.md)
