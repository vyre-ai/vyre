---
title: "ADR 0053: The public door"
summary: People outside your network reach your server through a relay that routes by server name and never decrypts. The server keeps the certificate, filters the paths, and opens no inbound port.
audience: builders
owner: relay
status: stable
---

# ADR 0053: The public door

Status: accepted, 10 Oct 2026 · Workstream: operations · Builds on ADR 0050 (the built-in network) and the name directory (ADR 0048).

## Context

A signer who has no Vyre, a client opening a published page and an outside agent calling the Vault or the agents MCP all start outside the network. Until now a server answered them only when it had a public port of its own. Most servers sit behind a home router or a cloud firewall and should stay there.

## Decision

One door for everything public: signing pages, previews and published pages, share links, webhooks and the two MCP endpoints.

1. **The relay routes and never decrypts.** A visitor's TLS connection reaches the operator's relay on port 443. The relay reads one server name from the first TLS record (16 KB at most, five seconds), asks the names directory which server serves that name, and passes the bytes to that server over the server's own outbound link. It holds no certificate and no key, so it cannot read a signer's session or a signed contract, and it cannot mint a certificate for any name.
2. **The directory decides who is served.** A server is reachable only under `<name>.vyre.run` when it declared shared links or webhooks, and under `<label>.<name>.vyre.run` (one label) when it declared apps. A suspended name, an unknown name and an undeclared host are the same plain no: the connection is closed before any server is told. Suspend is one call and needs no restart.
3. **The server keeps the certificate and filters the paths.** The server makes its own certificate by DNS-01 through the directory (signed by its own key), terminates TLS in its public gate, and lets through exactly the shapes it lists: share links, signed webhooks, the Vault MCP, the agents MCP and the app hosts it runs. Anything else is the same 404. An app host answers a stranger only on the routes its manifest lists, and never carries the owner's session.
4. **No inbound port.** The server dials out to the relay. Turning the door on is one setting, the address of an edge (`relay.tunnel_url`); with none set, only the person's own devices reach the server.
5. **The visitor's address crosses the hop.** The relay names the visitor on its own authenticated channel; the server's tunnel end connects to the gate from loopback, so it writes that address in a PROXY protocol v2 header ahead of the visitor's TLS bytes (`lib/publish/proxy.js`). The gate reads the header from loopback peers only and keys its budgets, blocks and the forwarded address on the visitor, so one stranger who spends a budget or is blocked does not lock out the rest. A stream with no usable address is refused, never sent as loopback.
6. **The edge is one small VM** running the relay container and a Caddy for the control link's certificate (`relay/deploy`). Deploying it, its DNS and the directory's secrets are the owner's decision.

## Consequences

- The relay's operator can see that a name was visited, from which address and how many bytes, never what was said. A compromised relay can refuse service but cannot impersonate a server, because it has no certificate for the name and the server's gate requires the server name to equal the Host header.
- Own domains (a firm's `sign.example.com`) were added in contract v2: the CNAME the certificate needs at `_acme-challenge.<host>` is also the proof of control, the directory lists the host for the name that owns that record, and the server gets and serves its own certificate for it by SNI. The relay is unchanged.
- A new public shape is a line in the gate's table and a row in `team/contracts/ingress.md`, not a new port.

## Proof

`relay/node/ingress.e2e.test.js` and `test/contracts/ingress.test.js` carry real sockets through a real Node relay; `relay/deploy/edge.live.test.js` does it through the container as it will run (read-only, no capabilities), and `relay/deploy/check.sh` checks a deployed edge from outside.
