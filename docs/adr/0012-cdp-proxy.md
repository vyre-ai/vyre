---
title: ADR 0012: Chrome's debugging port never leaves the container unauthenticated
summary: Chrome's remote-debugging port inside an agent's computer is reached only through computerd's bearer-checked routes, never directly over the internal Docker network.
audience: builders
owner: docs
status: stable
---

# ADR 0012: Chrome's debugging port never leaves the container unauthenticated

Status: accepted, 26 Sep 2026 · Workstream: computers · Spec: section 7.9 · Amends ADR 0003's port table

## The problem

Chrome's remote-debugging protocol (CDP) is the whole surface `hands-chrome` drives a computer
with: navigate, click, type, read the page, run arbitrary JavaScript. It has no authentication of
its own: whoever can open a WebSocket to it can do all of that, including read cookies and any
value the Vault autofilled into a form.

The image (`core/computers/image/`) started Chrome with `--remote-debugging-address=127.0.0.1`,
correctly loopback-only, but then ran `socat TCP-LISTEN:9223,fork TCP:127.0.0.1:9222` to relay it
out to a port of its own, published in ADR 0003's table so vyred's `computers.endpoint` could hand
hands-chrome a bare `cdp: "http://host:9223"`. That relay put the whole unauthenticated protocol on
the internal Docker network, reachable not just by vyred but by anything else on it, in
particular another agent's own container. Found in glass's review of ADR 0003.

## Decision

Chrome's debugging port is never reachable off `127.0.0.1` inside the container, full stop. The
only thing that ever dials it is `computerd`, which already answers every other route (`/health`,
`/apps`, `/tree`, `/act`, `/input`, `/screenshot`) behind `Authorization: Bearer <COMPUTERD_TOKEN>`
on port 7000. It grows two more routes on that same door:

- **`GET /cdp/json/version`**, bearer-checked like every other route: proxies Chrome's own
  `/json/version` and rewrites `webSocketDebuggerUrl` from `ws://127.0.0.1:9222/...` to
  `ws://<host>/cdp/...`, where `<host>` is whatever the caller used to reach computerd
  (`req.headers.host`): exactly the address it can dial next, real container or the fake driver's
  local mode alike.
- **A WebSocket upgrade at `/cdp/...`**: once its own check passes, a dumb authenticated pipe:
  `net.connect` to `127.0.0.1:9222`, replay the browser's own upgrade request with the `/cdp`
  prefix stripped and `Host` rewritten to Chrome's loopback address, then splice the two sockets.
  Nothing here parses CDP; gating happens once, at the door, the same as every other route.

A plain `WebSocket` (the one `modules/hands-chrome/cdp.js` uses, matching the browser-standard
API rather than a library with a headers option) cannot send an `Authorization` header, which is
the one thing every other computerd route relies on. So the upgrade's own check reads the token
from `?token=` on the URL instead. `cdp.js` appends it after fetching the (header-authenticated)
`/json/version`, and it is scrubbed from every error the same as the bearer token is everywhere
else in this codebase.

`core/computers/driver/index.js`'s `PORTS` drops `cdp` entirely: there is no longer a port for it.
`pool.js`'s `computers.endpoint` stops handing out a raw `cdp` URL, only `helper: {url, token}`,
and `cdp.js` builds `${helper.url}/cdp` itself. The image stops installing and running `socat`;
`EXPOSE` drops to 5900 (Xvnc) and 7000 (computerd) only.

## Consequences

- One more hop per CDP call's connection setup (computerd proxies the WebSocket instead of Chrome
  answering it directly), paid once per computer, not once per call. That is the whole reason `cdp.js`
  keeps one connection open and reused (its own header comment, "the 137x finding").
- computerd is now in the request path for every CDP byte, not just discovery. Its own crash or
  restart now also drops a live CDP session, where before only Chrome's own crash did. Restarting
  computerd is expected to be rare (it is the container's PID-1-adjacent foreground process); if
  this turns out to matter in practice, the fix is computerd surviving its own restart without
  taking the proxy down, not moving CDP back off the authenticated path.
- Unvalidated like the rest of the image: the raw-socket upgrade replay (stripping `/cdp`,
  rewriting `Host`, forwarding `head`) is written against documented HTTP/WebSocket upgrade
  mechanics, not run against a live Chromium. First things to check once a container boots: that
  Chromium's own `Host` check on the debugging port accepts `127.0.0.1:9222` from a proxied
  connection the way it would a direct one, and that GET `/json/version`'s exact JSON shape
  matches what `cdpVersion()` assumes.
