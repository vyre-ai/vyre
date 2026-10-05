# Your own relay and name directory

One container, `relay/Dockerfile`. It runs the Node relay (`relay/node/server.js`, port 8080) and the name directory (`names/worker`'s real code, port 8081). Nothing else is needed.

```
docker compose -f relay/compose.yml up -d --build
curl -s http://127.0.0.1:8080/health     # {"ok":true}
curl -s http://127.0.0.1:8081/health
```

- **State.** The relay keeps nothing on disk (a restart makes every box reconnect by itself). The directory keeps one file, `/data/directory.state`, in the `relay-data` volume: back that up.
- **No DNS.** The self-hosted directory publishes no DNS records. Names resolve through it and nowhere else, so point every device at it (`names.directory`).
- **TLS.** The container serves plain HTTP and WebSocket. The Vyre app and iPhones need `wss://` and `https://`, so terminate TLS in front of it. Caddy:

  ```
  relay.example.com { reverse_proxy 127.0.0.1:8080 }
  names.example.com { reverse_proxy 127.0.0.1:8081 }
  ```

  Keep `VYRE_TRUST_PROXY=1` (the compose file sets it) only behind a proxy that sets `x-forwarded-for`; without a proxy remove it, or a client can choose its own address and skip the per-address limits.
- **Settings.** `VYRE_RELAY_PORT`, `VYRE_DIRECTORY_PORT` (0 turns one off), `VYRE_RELAY_HOST`, `VYRE_STATE_DIR`, `VYRE_DIRECTORY_ORIGIN`, `VYRE_DIRECTORY_ZONE`.
- **Hardening in the compose file.** Non-root, read-only root filesystem, all capabilities dropped, memory and process limits, ports on loopback.
- Keep the hosted relay registered as the fallback: a device that cannot reach your address still gets in (team/0.3/RELAY-hosting.md, section 3).
