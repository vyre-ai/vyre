#!/usr/bin/env node
// A stand-in for the tailscale CLI in a Deck world (deck/test/world.js), so a world never reads the
// real Tailscale of the machine it runs on. The sample tailnet: alex's box, a MacBook online and
// an iPhone offline for eight days. Anything it does not know exits 1 with nothing on stdout.
const [cmd, ...args] = process.argv.slice(2);
const day = 86_400_000;
const status = {
  Version: "1.80.0", BackendState: "Running", MagicDNSSuffix: "tail0000.ts.net",
  CurrentTailnet: { Name: "alex@harlowlegal.com", MagicDNSSuffix: "tail0000.ts.net", MagicDNSEnabled: true },
  Self: { ID: "n1", HostName: "alex-box", DNSName: "alex-box.tail0000.ts.net.", OS: "linux", UserID: 1, TailscaleIPs: ["100.64.0.1"], Online: true },
  User: { 1: { ID: 1, LoginName: "alex@harlowlegal.com", DisplayName: "Alex Rivera" } },
  Peer: {
    k2: { ID: "n2", HostName: "alex-mbp", DNSName: "alex-mbp.tail0000.ts.net.", OS: "macOS", UserID: 1, TailscaleIPs: ["100.64.0.2"], Online: true, LastSeen: new Date().toISOString() },
    k3: { ID: "n3", HostName: "alex-iphone", DNSName: "alex-iphone.tail0000.ts.net.", OS: "iOS", UserID: 1, TailscaleIPs: ["100.64.0.3"], Online: false, LastSeen: new Date(Date.now() - 8 * day).toISOString() },
  },
};
if (cmd === "status" && args.includes("--json")) { process.stdout.write(JSON.stringify(status)); process.exit(0); }
if (cmd === "status") { process.stdout.write("100.64.0.1 alex-box alex@ linux -\n"); process.exit(0); }
if (cmd === "ip") { process.stdout.write(args.includes("-6") ? "fd7a:115c:a1e0::1\n" : "100.64.0.1\n"); process.exit(0); }
if (cmd === "version") { process.stdout.write("1.80.0\n"); process.exit(0); }
process.exit(1);
