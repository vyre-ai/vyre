#!/usr/bin/env node
// A stand-in for the Wink core CLI in unit tests. State lives in <socket dir>/fake.json; the test
// seeds "hostile" to make the pretend control plane push routes, an exit node, DNS and SSH.
//   hostile: "push-after-set"  prefs change after the first `set` (drift the module can repair)
//   hostile: "sticky"          the same, and every later `set` is ignored (drift that will not stay fixed)
//   hostile: "push-on-up"      the push lands during `up`, before the module's own `set`
import fs from "node:fs";
import path from "node:path";

const sockArg = process.argv.find(a => a.startsWith("--socket="));
const sock = sockArg.slice(9);
const args = process.argv.slice(2).filter(a => a !== sockArg);
if (!fs.existsSync(sock)) { process.stderr.write("failed to connect to local tailscaled\n"); process.exit(1); }
const file = path.join(path.dirname(sock), "fake.json");
const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const flag = (n, d) => { const a = args.find(x => x.startsWith(`--${n}=`)); return a === undefined ? d : a.slice(n.length + 3); };
const bool = (v, d) => (v === undefined ? d : v === "true");
state.calls = (state.calls || []).concat([args]);

const NODEKEY = "nodekey:" + "ab".repeat(32);
function defaults() {
  return { ControlURL: "", RouteAll: false, CorpDNS: true, RunSSH: false, RunWebClient: false, ExitNodeID: "", ExitNodeIP: "", Hostname: "", AdvertiseRoutes: null, AdvertiseServices: null,
    AdvertiseTags: null, DriveShares: null, AutoUpdate: { Check: true, Apply: false }, AppConnector: { Advertise: false }, PostureChecking: false };
}
function apply(p, from) {
  const login = flag("login-server"); if (login !== undefined) p.ControlURL = login;
  const h = flag("hostname"); if (h !== undefined) p.Hostname = h;
  if (flag("accept-routes") !== undefined) p.RouteAll = bool(flag("accept-routes"));
  if (flag("accept-dns") !== undefined) p.CorpDNS = bool(flag("accept-dns"));
  if (flag("ssh") !== undefined) p.RunSSH = bool(flag("ssh"));
  if (flag("exit-node") !== undefined) { p.ExitNodeIP = flag("exit-node"); p.ExitNodeID = ""; }
  if (flag("advertise-routes") !== undefined) { const v = flag("advertise-routes"); p.AdvertiseRoutes = v ? v.split(",") : null; }
  if (flag("advertise-tags") !== undefined) { const v = flag("advertise-tags"); p.AdvertiseTags = v ? v.split(",") : null; }
  if (flag("update-check") !== undefined) p.AutoUpdate.Check = bool(flag("update-check"));
  if (flag("auto-update") !== undefined) p.AutoUpdate.Apply = bool(flag("auto-update"));
  if (flag("webclient") !== undefined) p.RunWebClient = bool(flag("webclient"));
  if (flag("report-posture") !== undefined) p.PostureChecking = bool(flag("report-posture"));
}
const push = () => Object.assign(state.prefs, { RouteAll: true, CorpDNS: true, RunSSH: true, ExitNodeIP: "100.64.0.9", AdvertiseRoutes: ["0.0.0.0/0"] });

const cmd = args[0];
if (cmd === "up") {
  const k = flag("auth-key", "");
  if (k.startsWith("file:") && !fs.existsSync(k.slice(5))) { process.stderr.write("auth key file missing\n"); save(); process.exit(1); }
  if (state.failUp) { process.stderr.write("backend error: bad key\n"); save(); process.exit(1); }
  state.backend = "Running"; state.prefs = defaults(); apply(state.prefs);
  fs.writeFileSync(path.join(path.dirname(sock), "..", "state", "tailscaled.state"), JSON.stringify({ enrolled: true }), { mode: 0o600 });
  if (state.hostile === "push-on-up") { push(); state.authUrl = "https://evil.example/login"; }
  save();
} else if (cmd === "set") {
  if (args.some(a => a.startsWith("--advertise-tags"))) { process.stderr.write("flag provided but not defined: -advertise-tags\n"); process.exit(2); }
  if (state.hostile === "sticky" && state.setCount >= 1) { state.setCount++; save(); process.exit(0); }
  apply(state.prefs); state.setCount = (state.setCount || 0) + 1;
  if ((state.hostile === "push-after-set" || state.hostile === "sticky") && state.setCount === 1) { push(); state.authUrl = "https://evil.example/login"; state.exitStatus = true; }
  if (state.hostile === "push-after-set" && state.setCount === 2) state.authUrl = "";
  save();
} else if (cmd === "debug" && args[1] === "prefs") {
  save(); console.log(JSON.stringify(state.prefs || defaults()));
} else if (cmd === "status") {
  save();
  const s = { BackendState: state.backend || "NoState", AuthURL: state.authUrl || "", Self: { ID: "7", PublicKey: NODEKEY, TailscaleIPs: ["100.97.143.7"] }, Peer: state.peers || {} };
  if (state.exitStatus) s.ExitNodeStatus = { ID: "x", Online: true, TailscaleIPs: ["100.64.0.9/32"] };
  console.log(JSON.stringify(s));
} else if (cmd === "whois") {
  save();
  const ip = args[args.length - 1];
  const w = (state.whois || {})[ip];
  if (!w) { process.stderr.write("no match for IP\n"); process.exit(1); }
  console.log(JSON.stringify(w));
} else if (cmd === "logout") {
  state.backend = "NeedsLogin"; save();
} else { save(); process.stderr.write("unknown command\n"); process.exit(2); }
