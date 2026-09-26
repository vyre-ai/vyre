// @ts-check
// A fake `tailscale` for both machines of the journey harness, chosen by the first argument.
//
// box: the box's tailscaled, whose state is box-tailscale.json. It starts at NeedsLogin; `up`
//   (onboarding's Connect) adds an AuthURL, as tailscaled does once a login starts, and the test,
//   as the browser, writes Running when the person has signed in. Running reports 127.0.0.1 as
//   the node's address, so the tailnet listener can bind on this machine. `cert` copies a
//   self-signed certificate the rig made for vyre.tail0000.ts.net.
// mac: the Mac's Tailscale, Running as alex@example.com (or signed out, per mac-tailscale.json),
//   with the box as a peer once the box's own state is Running. The peer's address is 127.0.0.1,
//   so looking it up never leaves this machine.

import fs from "node:fs";

const rig = JSON.parse(fs.readFileSync(String(process.env.JOURNEY_RIG), "utf8"));
const [who, ...args] = process.argv.slice(2);
const read = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return {}; } };
const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const USER = { 7: { ID: 7, LoginName: "alex@example.com", DisplayName: "Alex" } };
fs.appendFileSync(rig.log.tailscale, `${who} ${args.join(" ")}\n`);

if (who === "mac") {
  const mac = read(rig.state.mac);
  if (mac.mode === "signed-out") { process.stdout.write(JSON.stringify({ BackendState: "NeedsLogin", AuthURL: "", Self: null, User: null, Peer: null }) + "\n"); process.exit(0); }
  const box = read(rig.state.box);
  const Peer = box.BackendState === "Running" || mac.peer
    ? { "nodekey:b0": { HostName: "vyre", DNSName: "vyre.tail0000.ts.net.", TailscaleIPs: ["127.0.0.1"], ID: "nbox", Online: true, UserID: 7, OS: "linux" } } : {};
  process.stdout.write(JSON.stringify({ BackendState: "Running", Self: { HostName: "laptop", DNSName: "laptop.tail0000.ts.net.", TailscaleIPs: ["100.64.0.2"], UserID: 7 }, User: USER, Peer }) + "\n");
  process.exit(0);
}

// the box
const s = read(rig.state.box);
switch (args[0]) {
  case "status":
    process.stdout.write(JSON.stringify(s) + "\n");
    break;
  case "up": {
    const url = "https://login.tailscale.com/a/f00d0000";
    if (s.BackendState !== "Running") fs.writeFileSync(rig.state.box, JSON.stringify({ ...s, AuthURL: url }));
    process.stderr.write(`\nTo authenticate, visit:\n\n\t${url}\n\n`);
    // tailscale up waits for the sign-in; a moment is enough for vyred to read the link.
    await new Promise(r => setTimeout(r, 300));
    break;
  }
  case "cert":
    fs.copyFileSync(rig.cert.crt, String(flag("--cert-file")));
    fs.copyFileSync(rig.cert.key, String(flag("--key-file")));
    break;
  case "whois":
    process.stdout.write(JSON.stringify({ Node: { Name: "laptop.tail0000.ts.net.", StableID: "nmac" }, UserProfile: { LoginName: "alex@example.com" } }) + "\n");
    break;
  case "debug":
    process.stdout.write(JSON.stringify({ OperatorUser: "vyre" }) + "\n");
    break;
  default:
    break;
}
