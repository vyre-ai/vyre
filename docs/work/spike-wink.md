# SPIKE-wink: the Wink network, measured

Spike run 3 Oct 2026 by the tailnet teammate's sub-agent, on testbox (8 CPUs, shared, load 6 to 31 from other teams' suites while this ran) and the Windows 11 VM that testbox hosts. Nothing ran on the Mac. Headscale v0.29.4, tailscale.com v1.102.4 (tsnet), Go 1.27.1. Code and scripts: `scripts/spike-wink/` on branch work/wink. All timings are agent measurements on a loaded host: trust ratios and orders of magnitude, not the last digit. No estimates in days anywhere.

## Verdict table

| # | Question | Verdict | Design consequence for DESIGN-wink.md |
|---|---|---|---|
| 1 | One headless headscale per space, several side by side | WORKS | Keep one instance per space. Own state dir, own loopback port, own metrics and gRPC port, own STUN port. About 45 MB RSS each, healthy 0.15 to 0.47 s after start. Pre-auth keys, tags and ACLs are all file and CLI driven; policy reloads on SIGHUP with no restart. |
| 2 | tsnet node inside the app, own ControlURL, AuthKey, own Dir | WORKS WITH CAVEAT | Caveat: tsnet uploads logs to Tailscale's log service unless `TS_NO_LOGS_NO_SUPPORT=true` is set (seen: a connection to a Tailscale address on 443; gone with the variable). `wink/forwarder/main.go` does not set it. Set it in `main()` before the first Server, and add a test. Cold join 4.7 to 5.2 s, idle RSS 33 MB, binary 22 MB stripped. |
| 3 | Several tsnet.Server in one process, different spaces | WORKS | One process can hold a node per space. +3.9 MB RSS and about 80 goroutines per extra node. The same IP in three spaces reached the right peer each time, so Dial is bound to the Server it is called on. Caveat: tsnet's environment knobs are process wide, so no per-space tuning of them. |
| 4 | Inside the iOS app | UNVERIFIED (compiles) | tsnet and its dependencies compile for ios/arm64. A linked archive needs cgo and the Xcode SDK, which testbox does not have. Everything about background, memory and the custom control URL on a device is UNVERIFIED; exact tests in section 4. |
| 5 | Relay as fallback when no direct and no DERP path | WORKS WITH CAVEAT | The relay cannot carry tsnet's WireGuard. It can carry an application stream: measured on the Node relay, 0.58 ms p50 and 430 to 540 Mbit/s on loopback. Caveat: no per-stream fairness, a ping waits 390 ms behind a bulk stream. The peer-channel header needs a relay variant (identity comes from the Noise key, not a node key). The Cloudflare Worker's real latency is UNVERIFIED. |
| 6 | Windows, userspace, no driver | WORKS WITH CAVEAT | Joined, dialled and answered. Up in 6.1 s, working set 71 MB (private 55 MB), 22 MB exe. No firewall rule was created. An interactive firewall prompt could not be observed over ssh: UNVERIFIED. |
| - | Taildrop and Taildrive from an embedded node | FAILS (not relied on) | tsnet exposes neither; its source carries a TODO about Taildrive. Both stay on the Tailscale path until rebuilt. |

## 1. Headscale per space, headless

Setup (`hs-up.sh`, `hs-key.sh`): a config file, a self-signed certificate for the embedded DERP, a policy file, a unix admin socket. No UI, no browser, no OIDC, no web admin. Three instances (A, B, C) plus a fourth for the Windows test ran together.

- Startup: `healthy_after_s` 0.47, 0.31, 0.30 (first run) and 0.15, 0.16, 0.15 (second), measured as the time until `/health` answers 200, host load 7 to 11.
- Memory: 44.4, 45.5, 44.7 MB RSS right after start (idle, no nodes).
- Side by side: works. Each needs a distinct `listen_addr`, `metrics_listen_addr`, `grpc_listen_addr`, STUN port, and its own state dir (db, noise key, DERP key). I used 28081 to 28083, metrics +1000, gRPC +2000, STUN 23478 to 23480. All three shared the same /24 on purpose.
- Pre-auth keys: `headscale users create owner`, then `headscale preauthkeys create -u <id> -e 10m --tags tag:hub -o json` over the unix socket. Keys are single use by default: a second node with the same key gets `backend: authkey already used`.
- ACL policy: the file in `hs-up.sh` (device to hub on 7000, hub to device on 7000). Enforced: device to device on 7000 timed out after 8 s. After editing the file and `kill -HUP`, headscale logged `Policy reload completed with changes` and the same dial answered in 5 ms. No restart, no node reconnect.
- Embedded DERP: enabled with `derp.server.enabled: true`. It needs TLS on the listener (headscale serves the certificate itself) and the clients must trust that certificate. A node showed `home is now derp-999 (wink)` and `derphttp.Client.Connect: connecting to derp-999`. With embedded DERP on, `derp.paths: []` works; the dummy region file in `core/wink/control/headscale.js` is only needed when the embedded DERP is off (the Windows run used it).
- Same-host artifact: a control URL on a non-loopback local address of the same machine hangs (SYN-SENT), because tsnet binds its sockets to the default-route interface. A real remote headscale does not hit this. Test setups that put headscale and a node on one host must use 127.0.0.1.

## 2. tsnet node inside the app

`scripts/spike-wink/main.go`: `tsnet.Server{Dir, Hostname, ControlURL, AuthKey, Ephemeral: false}`, serves a TCP service on :7000 on the tailnet, dials another node.

- Cold join (register, map, home DERP): `up_ms` 5223, 5241, 5211, 5084, 5213, 4746, 4904, 4780. A verbose timeline: register response +1.1 s (headscale under load), netmap +0.1 s, then about 3 s until tsnet picks a home DERP and reports Running. Restart with saved state: 3.8 s once; a second restart returned in 0.1 s with the known address and no peers yet. Plan on "address known immediately, peers within about 4 s".
- Memory: process RSS 17 MB before the node, 33 MB after Up, 90 to 117 MB during a 64 MB bulk transfer (netstack buffers and Go heap; not released within the run).
- Binary: linux/amd64 31.8 MB unstripped, 22.0 MB windows/amd64, 21.3 MB android/arm64, 20.2 MB darwin/arm64 with `-trimpath -ldflags="-s -w"`, CGO off.
- Privacy: with default settings tsnet opened a TLS connection to a Tailscale address on 443 (log upload). With `TS_NO_LOGS_NO_SUPPORT=true`, `ss` showed only the control connection. This is a must-fix in the forwarder and in any in-app node. tsnet also still writes `tailscaled.log*.txt` in the state dir.
- Throughput and latency to a peer on the same host, direct path (host load 6 to 11): ping p50 0.71 ms, p95 2.63 ms (500 pings); 331 Mbit/s hub to node, 348 Mbit/s node to hub, 64 MB each.

## 3. Several nodes in one process

`multi.conf.json`: m-a and m-a2 (space A), m-b (space B), m-c (space C), each its own Hostname, Dir and headscale, one process.

- Coexist: yes, all four up and serving. Up times 5.2, 5.2, 5.2, 5.1 s (sequential; they could be started in parallel).
- RSS after each Up: 33.3, 37.1, 41.2, 44.8 MB (about +3.9 MB per extra node; goroutines 91, 166, 234, 316 so about +75 each). Under load with all four: 47.5 MB.
- Space isolation: every space had its hub at 100.97.143.1. m-a, m-b and m-c each dialled that same address at the same moment and got `node=peer-A`, `node=peer-B`, `node=peer-C` respectively, dial 15 to 21 ms. m-a dialling an address that does not exist in A (it exists in no space) timed out at 8 s. A Dial from a Server can only reach its own space's netmap, so the binding is the Server object. Never use a package level dial or the process default route.
- Concurrency: three ping loops of 200 ran at once, one per space: p50 0.98, 1.03, 1.03 ms; p95 4.2, 3.8, 3.8 ms.
- Process-global: environment knobs (`TS_NO_LOGS_NO_SUPPORT`, `TS_DEBUG_ALWAYS_USE_DERP`) apply to every Server in the process. `UserLogf` and `Logf` are per Server.
- Crash domain: one panic takes down every space in the process. Decision for the lead below.

## 4. iOS

What was verifiable without a device:

- `CGO_ENABLED=0 GOOS=ios GOARCH=arm64 go build tailscale.com/tsnet` (tsnet and every dependency, no link) succeeded in 2 min 18 s. Linking the harness fails with `ios/arm64 requires external (cgo) linking, but cgo is not enabled`; with cgo it fails with `cgo: C compiler "clang" not found` (no Apple clang or SDK on testbox). ios/amd64 also compiles (1 min 53 s). A gomobile or c-archive build therefore has to run on a Mac (GitHub Actions macOS runner or the Mac under the build lock, on the lead's go).
- Source evidence that upstream intends tsnet in an app: `tsnet.go` has an iOS branch that says "When compiled as a framework (via TailscaleKit in libtailscale), os.Executable() returns an error on iOS". tsnet needs no NetworkExtension and no VPN profile: it is a userspace stack inside the app process, so no system VPN prompt and no entitlement.
- Custom control URL: `Server.ControlURL` is a documented field and nothing in the iOS path replaces it. Headscale registration worked from the same code on Linux and Windows.

Limits that apply, from Apple's rules and not measured here: a network extension is limited to about 50 MB, and this node idles at 33 MB with 90 MB or more under load, so a node inside an extension is out. In the app process the node runs only while the app runs; iOS suspends it within seconds of going to the background, so there is no inbound listening while backgrounded.

UNVERIFIED, tests to run on a real iPhone:
1. Build a TailscaleKit or c-archive on a Mac, link into a stub app, call Up with ControlURL, AuthKey and a Dir under Application Support. Pass: running state and a tailnet address within 10 s.
2. Dial the box's :7000 echo over Wi-Fi, then over cellular (UDP often blocked). Pass: answer in both; record the path (direct, DERP, none).
3. Background the app for 60 s and bring it back. Pass: the node recovers and a dial works within 10 s with no re-enrolment.
4. Read resident memory in Instruments with two spaces joined. Pass: stays under the app's jetsam limit with a margin of 50 MB.
5. Same with the relay path only (section 5).

## 5. Relay fallback

Forced DERP versus direct (same host, bench node in space A, `TS_DEBUG_ALWAYS_USE_DERP=1` on the bench node only, which turns off its UDP):

| path | ping p50 | ping p95 | hub to node | node to hub | first dial |
|---|---|---|---|---|---|
| direct | 0.71 ms | 2.63 ms | 331 Mbit/s | 348 Mbit/s | 9 to 21 ms |
| embedded DERP | 1.07 ms | 2.31 ms | 82 Mbit/s | 89 Mbit/s | 5.1 s, then 8.5 s on a fresh process |

DERP costs about a quarter of the bulk throughput and the first connection is slow to set up (up to two 8 s dial attempts after a restart). The latency is loopback class here and says nothing about a real network.

No path at all: I pointed the embedded DERP at a blackhole address (192.0.2.1) in space C and ran a node with UDP off. `Up` succeeded (8.2 s), the peer was in the netmap, and the dial failed with `context deadline exceeded` after 25 s. With UDP blocked and the DERP address unreachable, tsnet has no transport and WireGuard cannot move a byte. I did not change testbox's firewall (shared host); the knob and the blackhole stand in for blocked UDP and blocked 443.

What the existing relay carries: `scripts/spike-wink/relay-bench.mjs` runs the real `relay/node/server.js`, a real box (route key, signed challenge, ticket) and a real device, with `core/relay/channel.js` Noise IK on both ends. A Stream opened with a head carries bytes both ways, like a peer connection would:

- connect and handshake 18 ms
- 1-byte round trip, 300 samples: p50 0.58 ms, p95 0.88 ms, max 2.4 ms
- device to box 32 MB at 430 Mbit/s, box to device 540 Mbit/s
- a ping on a second stream while a 32 MB bulk stream ran: 390 ms. There is no per-stream flow control or queueing order, and one WebSocket is one queue.
- process RSS 239 MB at the end (the test queues all bulk frames at once)

The Worker: `node --test relay/worker/*.test.js` passes 57 of 57, and the README says it speaks the Node relay's protocol, so the same frames apply. Latency and throughput through Cloudflare were not measured (no deployed Worker for this spike): UNVERIFIED. Expect a real network round trip plus Durable Object hop, not 0.6 ms.

What the relay can be for the wink peer channel: an application transport, not a network. The box side is `core/relay/bridge.js`, which today turns each stream into an HTTP request or a `ws` head. A third head kind (a peer connection) can hand the stream to `core/wink/node/peer-channel.js`. Two changes are needed: the header's `nodeKey`, `stableId` and `remoteAddr` are tailnet identities, but a relay caller is identified by the device's Noise key (`channel.peer`), so the header gains a `via: "relay"` form with the device id; and the sender needs fair queueing (small frames first, bulk in 64 KiB slices) or control traffic stalls behind bulk. Also checked: tsnet's DERP-over-WebSocket client exists in 1.102.4 but only for `js` and for linux and darwin builds with the `ts_debug_websockets` tag, so it is not available on iOS or Windows; and the headscale server side was not checked. It is not an option for the fallback.

Detecting the case: the dial timeout is the only signal in the blackhole test (the peer showed as `derp wink` while nothing flowed). The app should race a tsnet dial against the relay and keep the first answer, rather than wait 25 s.

## 6. Windows

The Windows 11 VM on testbox, reached over its ssh forward. The exe ran from a temporary folder (removed afterwards), userspace only, no driver, no service, no admin step. Control was a headscale on testbox with the embedded DERP off (the guest cannot reach the loopback DERP address), over plain HTTP at the guest's host alias, so no certificate import was needed.

- Up: 6.1 s and 7.1 s in two runs (guest is a 4-vCPU VM on a loaded host).
- Memory: working set 71.3 MB, private bytes 55.2 MB, 15 threads, measured 25 s after start while it was waiting to dial.
- Dial and answer: `node=peer-W` answered, then 200 pings p50 4.5 ms, p95 11.1 ms, max 206 ms (QEMU user networking plus load). The path settled on a direct address after 36 s: with no DERP in this setup the two nodes had to find each other with direct pings only. Time to first byte is therefore dominated by the missing DERP in the test, not by Windows.
- Firewall: no `winkspike` rule appeared in `Get-NetFirewallRule`. Over ssh there is no desktop session, so a "Windows Defender Firewall has blocked" prompt would not show; whether one appears when a user launches the exe by double click is UNVERIFIED. Test: log in on the VM console, run the exe from Explorer, and see whether the prompt shows. The listen is inside netstack (no OS listening socket), so none is expected; the outbound UDP socket does not normally prompt.
- A background process started over ssh died when the ssh session ended. Not a tsnet finding; use a scheduled task or the app's own service for a long run.

## Not done and why

- Real blocked UDP with iptables or a netns: the host is shared with the live box, so I used `TS_DEBUG_ALWAYS_USE_DERP` and a blackholed DERP address.
- Cloudflare Worker numbers: no deployment.
- Linked iOS archive and anything on a device: no Mac, no phone.
- Windows interactive prompt: see section 6.

## Decisions for the lead

1. In-process nodes per space versus one forwarder process per space. In-process works (+3.9 MB, correct isolation) but shares one crash domain and process-wide knobs. Recommendation from the data: in-process on mobile and desktop for the active space, one forwarder per space on boxes.
2. Fix now: set `TS_NO_LOGS_NO_SUPPORT=true` in `wink/forwarder/main.go`, with a test. A Wink node that phones home contradicts the self-hosted claim.
3. Approve the relay peer-stream variant (a `peer` head in bridge.js, a `via: "relay"` header in peer-channel.js, fair queueing in the channel). Without it a blocked network means no Wink at all.
4. iOS plan: the Mac build and the five device tests in section 4 before DESIGN-wink promises a phone node.
