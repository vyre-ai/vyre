# spike-wink

Harness for the Wink network spike (results in team/0.3/SPIKE-wink.md). Runs on testbox only, never on the Mac.

- `main.go`: `winkspike`, one or more embedded tsnet nodes in one process. Each serves a tiny TCP service on :7000
  (hello, ping, src N, sink N) and can run dial tests. JSON lines out. `-conf nodes.json` for several nodes.
- `hs-up.sh`: one headless headscale per space (config file, loopback listener, embedded DERP on TLS, unix admin socket).
- `hs-key.sh`: mint a 10 minute pre-auth key with a tag over the unix socket.
- `reset.sh`: wipe and restart three spaces (A, B, C) with the same /24 prefix on purpose.
- `multi.conf.json`, `bench-*.conf.json`: the several-nodes-in-one-process and throughput tests.
- `relay-bench.mjs`: the Vyre relay carrying a byte stream (`node scripts/spike-wink/relay-bench.mjs` from the repo root).

Build: `CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o winkspike .` (GOOS=windows works the same).
Always run nodes with `TS_NO_LOGS_NO_SUPPORT=true`: without it tsnet uploads logs to Tailscale's log service.
Trust the headscale test certificates with `SSL_CERT_FILE=<bundle>`. Clean up by pidfile only.
- `kernel-pair.sh` / `kernel-pair.mjs`: two Spaces, one homed on each of two real machines, paired with the real Wink flow (wink.server.code / wink.pair.server), a real relay, a headscale per Space and the Go node on both sides, with the home's door wrapped as `homeServe(peers, withKernelCall(...))`, for the remote kernel call and a role change across machines. `kernel-pair.sh up | status | call | selftest | bench | reconnect | block-udp | unblock-udp | down`.
