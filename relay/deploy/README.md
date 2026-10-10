# The public edge: deploy runbook

One small VM that lets people outside your network (a signer on a phone, a client opening a published page) reach a box. Design: team/0.3.1/DESIGN-public-ingress.md. Contract: team/contracts/ingress.md.

What runs there: the relay (`relay/Dockerfile`, the same image as a self-hosted relay) and Caddy, from `relay/deploy/compose.yml`. The relay holds no certificate and no key. It reads one server name from a visitor's first TLS record, asks the names Worker which box serves it, and passes the bytes to that box over the box's own outbound link. Caddy only gives the boxes' control link its certificate (8443) and fronts port 80.

Proven before any VM exists: the image builds, runs read-only as `node` with no capabilities, carries a signer to a box through its published ports, refuses an undeclared name and answers port 80 with the fixed redirect (`VYRE_EDGE_LIVE=1 node --test relay/deploy/edge.live.test.js` on a box with Docker); `check.sh` passes against that container. Only these need the real VM and the real zone: Caddy's certificate for `edge.vyre.run`, the Worker secrets, DNS, and the call from a phone.

## Steps (each needs the owner's yes first: it adds a server and touches vyre.run)

1. **VM.** DigitalOcean, `s-1vcpu-2gb` (about 12 USD a month, 2 TB transfer), region `nyc3`, Ubuntu LTS, a Reserved IP attached. Firewall: 22 from your address only, 80, 443, 8443. Install `docker.io`, `docker-compose-v2`, `git`, `unattended-upgrades`. Docker's published ports bypass `ufw`, so use the provider firewall, not `ufw`, for 80/443/8443.
2. **Code.** `git clone --depth 1 --branch <release tag> https://github.com/vyre-ai/vyre /opt/vyre`, then `cd /opt/vyre/relay/deploy`.
3. **Secret.** `echo "VYRE_RELAY_SECRET=$(openssl rand -hex 32)" > .env && chmod 600 .env`. Keep the value for step 5.
4. **DNS.** In the vyre.run zone (Cloudflare, grey cloud, ttl 60): one record, `A edge -> <the reserved IP>`. No zone wildcard: the directory writes `A <name>` and `A *.<name>` for each box, pointing at this IP only for names that declared the tunnel.
5. **Worker secrets** (names Worker, `names/worker`). Put `NAMES_RELAY_SECRET` (the value from step 3) and `NAMES_TUNNEL_IPV4` (the reserved IP) in the `deploy` environment's secrets, and `NAMES_ADMIN_SECRET` too if it is not there (32+ characters, `openssl rand -hex 32`; suspend and takedown use it). Then run `gh workflow run relay-deploy.yml --ref main -f sha=<sha on stage> -f names=true -f names_tunnel_secrets=true` and approve its `deploy` environment. The Worker's zone token never leaves the Worker.
6. **Start.** `docker compose --env-file .env up -d --build`. Caddy fetches the certificate for `edge.vyre.run` by HTTP-01 on port 80 (port 443 belongs to the relay), so DNS must resolve first.
7. **Check from outside.** From your laptop: `EDGE_IP=<reserved IP> sh relay/deploy/check.sh`. Every line must say PASS.
8. **Point a box at it.** On the box: `vyre config set relay.tunnel_url wss://edge.vyre.run:8443`. The box publishes `<name>.vyre.run` and `*.<name>.vyre.run` through the tunnel and makes its own certificate (DNS-01 through the Worker, signed by the box's key).
9. **Phone test.** On mobile data, open `https://documents.<name>.vyre.run/sign/<document>/<signer>` from a real signing request; sign; open the emailed 30-day link. Then `EDGE_NAME=<name> sh relay/deploy/check.sh`.
10. **Suspend drill.** `curl -X POST https://names.vyre.run/v1/names/admin/suspend -H "x-vyre-admin: $ADMIN_SECRET" -d '{"name":"<name>","on":true}'`; a new visitor is refused within a minute (the relay keeps a directory answer 60 seconds), an open stream closes at the next 30-second re-check. `"on":false` lifts it.

## Rollback

- Unset `relay.tunnel_url` on the box and it republishes direct (or not at all); signing pages go dark outside the tailnet, nothing else changes.
- `docker compose down` on the VM: boxes keep working over the tailnet; only the public door is dark.
- A name abused or lost: the suspend call above, or `POST /v1/names/admin/drop`.

## Running notes

- The VM keeps no user data: the relay's state is in memory, `relay-data` holds nothing the relay needs, and `caddy-data` holds the control link's certificate (it is made again if lost).
- Update: `git pull`, then `docker compose --env-file .env up -d --build`. Boxes reconnect by themselves.
- Logs: `docker compose logs relay`. A visitor's address reaches the box in the relay's own open message, never in the byte stream.
