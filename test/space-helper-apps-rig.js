// @ts-check
// The rig for the app module half of the Space helper (test/space-helper-apps.test.js). It is test/space-helper-rig.js with two fakes put in front of the Space helper's own: they answer what an app
// needs (the app's network and container, the vyre container's address and interface on it, INPUT and OUTPUT rules kept per chain, the throwaway containers that prove the walls) and hand every
// other call to the originals untouched, so the Twenty paths run as they do in the Space helper's own tests.
import fs from "node:fs";
import path from "node:path";
import { rig, REPO } from "./space-helper-rig.js";

const DOCKER_APP = `
const fs = require("fs"), cp = require("child_process");
const F = "__F__", REPO = "__REPO__";
const a = process.argv.slice(2);
const has = n => fs.existsSync(F + "/" + n);
const rd = (n, d = "") => has(n) ? fs.readFileSync(F + "/" + n, "utf8").replace(/\\n$/, "") : d;
const out = s => { process.stdout.write(s + (s.endsWith("\\n") ? "" : "\\n")); process.exit(0); };
// the originals log every call themselves: the line written above is taken back out before they are handed one
const base = () => { const l = fs.readFileSync(F + "/calls", "utf8").split("\\n"); l.splice(l.length - 2, 1); fs.writeFileSync(F + "/calls", l.join("\\n")); const r = cp.spawnSync("node", [F + "/docker-base.cjs", ...a], { stdio: "inherit" }); process.exit(r.status ?? 1); };
const CTR = "vyre-vyre-1";
const appOf = s => (/vyre-app-([a-z0-9-]+?)(?:_net|$)/.exec(String(s)) || [])[1];
const joined = () => rd("joined").split("\\n");
// every call is logged in the same file as the originals use, one line per call, with the env file CONTENT never in it (it is read below)
fs.appendFileSync(F + "/calls", a.join(" ") + "\\n");
if (a[0] === "inspect" && a[2] === "{{.Image}}" && a[3] === CTR && has("ctr-image")) out(rd("ctr-image"));
if (a[0] === "inspect" && a[1] === "-f" && a[2].includes("index .NetworkSettings.Networks") && a[3] === CTR) {
  const net = (/Networks \\\\?"([^"\\\\]+)\\\\?"/.exec(a[2]) || [])[1];
  out(joined().includes(net) ? rd("vip", "172.31.7.2") : "");
}
if (a[0] === "inspect" && a[3] === "appc1") out(a[2].includes("Global") ? "invalid IP" : "172.31.7.3");
if (a[0] === "ps" && a.join(" ").includes("label=com.docker.compose.project=vyre-app-")) {
  const m = (/project=vyre-app-([a-z0-9-]+)/.exec(a.join(" ")) || [])[1];
  out(m && has("app-running-" + m) ? "appc1" : "");
}
if (a[0] === "network" && a[1] === "inspect" && appOf(a[a.length - 1]) && /vyre-app-[a-z0-9-]+_net$/.test(a[a.length - 1])) {
  if (!has("app-net-" + appOf(a[a.length - 1]))) process.exit(1);
  out(a.includes("-f") ? rd("app-subnets", "172.31.7.0/24 ") : "{}");
}
if (a[0] === "compose" && /vyre-app-/.test(a[a.indexOf("--project-name") + 1] || "")) {
  const m = appOf(a[a.indexOf("--project-name") + 1]);
  const sub = a[a.indexOf("-f") + 2];
  if (sub === "create") {
    if (has("create-fails")) process.exit(1);
    fs.writeFileSync(F + "/app-net-" + m, "1");
    fs.copyFileSync(a[a.indexOf("-f") + 1], F + "/compose-at-create-" + m);
    fs.copyFileSync(a[a.indexOf("--env-file") + 1], F + "/env-at-create-" + m);
    process.exit(0);
  }
  if (sub === "up") { if (has("up-fails")) process.exit(1); fs.writeFileSync(F + "/app-running-" + m, "1"); process.exit(0); }
  if (sub === "stop") { fs.rmSync(F + "/app-running-" + m, { force: true }); process.exit(0); }
  if (sub === "down") { fs.rmSync(F + "/app-running-" + m, { force: true }); fs.rmSync(F + "/app-net-" + m, { force: true }); process.exit(0); }
  process.exit(0);
}
// the build's own network (trust row 37): made once, its bridge name checked, and a probe container on it that must find everything closed
if (a[0] === "network" && a[1] === "create" && a.includes("vyre-pub-build")) { fs.appendFileSync(F + "/pubnet-create", a.join(" ") + "\\n"); fs.writeFileSync(F + "/pubnet", "1"); process.exit(0); }
if (a[0] === "network" && a[1] === "inspect" && a[a.length - 1] === "vyre-pub-build") {
  if (!has("pubnet")) process.exit(1);
  if (a.includes("-f")) out(a[a.indexOf("-f") + 1].includes("bridge.name") ? rd("pubnet-bridge", "vyrepub0") : "172.40.0.1");
  out("{}");
}
if (a[0] === "run" && a.includes("--network") && a[a.indexOf("--network") + 1] === "vyre-pub-build" && !a.includes("--name")) {
  fs.appendFileSync(F + "/pubnet-probes", (/nc -w 2 -z ([0-9.]+)/.exec(a[a.length - 1]) || [])[1] + "\\n");
  out(has("pubnet-leaky") ? "OPEN" : "CLOSED");
}
// published servers (pub-build, pub-up): the rootless BuildKit run, docker load, the image id of root's tag
if (a[0] === "run" && a.includes("--name") && a[a.indexOf("--name") + 1] === "vyre-pub-build") {
  fs.appendFileSync(F + "/pub-builds", a.join(" ") + "\\n");
  if (has("build-fails")) { process.stderr.write("#7 ERROR: process npm ci did not complete successfully: exit code: 1\\n"); process.exit(1); }
  const mnt = a.filter((x, i) => a[i - 1] === "-v" && x.endsWith(":/out"))[0];
  const o = (a[a.indexOf("--output") + 1] || "").split(",")[1].replace("name=", "");
  fs.writeFileSync(F + "/pub-tag", o || "");
  if (!has("no-tar") && mnt) fs.writeFileSync(mnt.split(":")[0] + "/image.tar", "TAR".repeat(10));
  process.exit(0);
}
if (a[0] === "load") { if (has("load-fails")) process.exit(1); fs.writeFileSync(F + "/pub-loaded", "1"); out("Loaded image: " + rd("pub-tag")); }
if (a[0] === "image" && a[1] === "inspect" && a[2].startsWith("vyre-pub/")) {
  if (has("pub-image-gone") || !has("pub-loaded")) process.exit(1);
  out("sha256:" + require("crypto").createHash("sha256").update(a[2]).digest("hex"));
}
if (a[0] === "pull" && a[a.length - 1].includes("docuseal/docuseal")) {
  if (has("pull-fails-app")) { process.stderr.write("pull access denied\\n"); process.exit(1); }
  fs.appendFileSync(F + "/pulled", a[a.length - 1] + "\\n"); fs.writeFileSync(F + "/app-image-have", "1"); process.exit(0);
}
// the app's image is on this machine only after a pull (or when a test says it already is)
if (a[0] === "image" && a[1] === "inspect" && a[a.length - 1].includes("docuseal/docuseal")) process.exit(has("app-image-have") ? 0 : 1);
if (a[0] === "exec" && a.includes("node") && a.some(x => x.includes("config.json"))) { if (has("public")) out(rd("public")); process.exit(0); }
if (a[0] === "exec") {
  const ei = a.indexOf("--env-file");
  if (ei >= 0) {
    fs.writeFileSync(F + "/exec-env", fs.readFileSync(a[ei + 1]));
    fs.writeFileSync(F + "/exec-env-mode", (fs.statSync(a[ei + 1]).mode & 0o777).toString(8));
    fs.writeFileSync(F + "/exec-args", a.join(" "));
    fs.writeFileSync(F + "/exec-stdin", a.includes("-i") ? fs.readFileSync(0) : "");
    if (has("exec-fails")) process.exit(1);
    out(rd("setup-out", "boot noise\\napi_token=tok_" + "a".repeat(40) + "\\nlogin_password=pw_" + "b".repeat(24)));
  }
  process.exit(0);
}
if (a[0] === "run" && a.includes("--entrypoint")) {
  const ep = a[a.indexOf("--entrypoint") + 1];
  if (ep === "cat") { const p = a[a.length - 1].replace("/opt/vyre", REPO); out(has("script-text") ? rd("script-text") : fs.readFileSync(p, "utf8")); }
  const i = a.indexOf("-e");
  if (ep === "node" && i > 0) {
    const script = a[i + 1], args = a.slice(i + 2);
    if (script.includes("host-pub.js")) {
      fs.appendFileSync(F + "/pubplans", args.join(" ") + "\\n");
      if (has("hostpub-fails")) process.exit(1);
      const mnt = a.filter((x, k) => a[k - 1] === "-v" && x.endsWith(":/ctx:ro"))[0];
      const r = cp.spawnSync("node", ["-e", 'import(process.env.REPO + "/core/appmods/host-pub.js").then(m=>process.stdout.write(m.run(process.argv.slice(1))))', ...args], { encoding: "utf8", env: { ...process.env, REPO, ...(mnt ? { VYRE_PUB_CTX: mnt.split(":")[0] } : {}) } });
      let outText = r.stdout || "";
      // a generator that forgot the guards, to see the lint refuse it
      if (args[0] === "compose" && has("pubcompose-no-readonly")) outText = outText.replace("    read_only: true\\n", "");
      if (args[0] === "compose" && has("pubcompose-no-tmpfs")) outText = outText.replace(/    tmpfs:\\n      - [^\\n]*\\n/, "");
      process.stdout.write(outText); process.exit(0);
    }
    if (script.includes("host-plan.js")) {
      if (args[0] === "list" && has("hostplan-list")) out(rd("hostplan-list"));
      if (args[0] === "compose" && has("hostplan-compose-" + args[1])) out(rd("hostplan-compose-" + args[1]));
      if (args[0] === "compose" && has("hostplan-compose")) out(rd("hostplan-compose"));
      if (has("hostplan-fails")) process.exit(1);
      base();
    }
    if (script.includes("net").valueOf() && script.includes('require("net")')) {
      fs.appendFileSync(F + "/tries", a[a.indexOf("--network") + 1] + " " + args.join(" ") + "\\n");
      out(rd("try-" + args[1], args[1] === rd("hook-port", "43001") ? "refused" : "timeout"));
    }
    if (script.includes("fetch(")) { fs.appendFileSync(F + "/waits", args.join(" ") + "\\n"); out(rd("wait", "ok")); }
  }
}
base();
`;

const NSENTER_APP = `
const fs = require("fs"), cp = require("child_process");
const F = "__F__";
const a = process.argv.slice(2);
const has = n => fs.existsSync(F + "/" + n);
const pid = a[1];
const cmd = a.slice(3);
const base = () => { const r = cp.spawnSync("node", [F + "/nsenter-base.cjs", ...a], { stdio: "inherit" }); process.exit(r.status ?? 1); };
if (cmd[0] === "ip") { fs.appendFileSync(F + "/calls", "nsenter " + a.join(" ") + "\\n"); process.stdout.write(has("no-iface") ? "" : "7: eth1    inet " + (fs.existsSync(F + "/vip") ? fs.readFileSync(F + "/vip", "utf8").trim() : "172.31.7.2") + "/24 brd 172.31.7.255 scope global eth1\\n"); process.exit(0); }
if (cmd[0] === "cat") { fs.appendFileSync(F + "/calls", "nsenter " + a.join(" ") + "\\n"); process.stdout.write(has("listen") ? fs.readFileSync(F + "/listen", "utf8") : ""); process.exit(0); }
const file = F + "/appfw-" + pid;
const load = () => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
const save = r => fs.writeFileSync(file, JSON.stringify(r));
const parse = toks => {
  const r = {}; const t = toks.slice();
  while (t.length) {
    const k = t.shift();
    if (k === "-i") r.i = t.shift(); else if (k === "-s") r.s = t.shift(); else if (k === "-d") r.d = t.shift(); else if (k === "-p") r.p = t.shift();
    else if (k === "-m") { const m = t.shift(); if (m === "owner" || m === "comment" || m === "conntrack" || m === "tcp") continue; r.bad = k + " " + m; }
    else if (k === "--uid-owner") r.uid = t.shift(); else if (k === "--comment") r.c = t.shift().replace(/"/g, ""); else if (k === "--ctstate") r.ct = t.shift().split(",").sort().join(",");
    else if (k === "--dport") r.dp = t.shift(); else if (k === "-j") r.j = t.shift(); else if (k === "--reject-with") t.shift(); else r.bad = k;
  }
  return r;
};
const same = (x, y) => JSON.stringify(Object.entries(x).sort()) === JSON.stringify(Object.entries(y).sort());
const form = (ch, r) => "-A " + ch + (r.s ? " -s " + r.s : "") + (r.d ? " -d " + r.d : "") + (r.i ? " -i " + r.i : "") + (r.p ? " -p " + r.p + " -m " + r.p : "") + (r.dp ? " --dport " + r.dp : "") + (r.ct ? " -m conntrack --ctstate " + r.ct.split(",").reverse().join(",") : "") + (r.uid ? " -m owner --uid-owner " + r.uid : "") + ' -m comment --comment "' + r.c + '"' + " -j " + r.j + (r.j === "REJECT" ? " --reject-with icmp-port-unreachable" : "");
if (cmd[0] === "iptables" || cmd[0] === "ip6tables") {
  const rest = cmd.slice(2);
  if (rest[0] !== "-S" && !rest.join(" ").includes("vyre-app:")) base();
  fs.appendFileSync(F + "/calls", "nsenter " + a.join(" ") + "\\n");
  const rules = load();
  const op = rest[0], ch = rest[1];
  if (op === "-S") {
    // the originals' list (Twenty's rules, per pid) first, then ours
    const own = rules.filter(x => x.ch === ch).map(x => form(ch, x.r));
    let theirs = "";
    if (ch === "OUTPUT") { const r = cp.spawnSync("node", [F + "/nsenter-base.cjs", ...a], { encoding: "utf8" }); theirs = r.stdout || ""; }
    process.stdout.write(theirs + own.join("\\n") + (own.length ? "\\n" : "")); process.exit(0);
  }
  const hasPos = op === "-I" && /^[0-9]+$/.test(rest[2]);
  const spec = parse(rest.slice(hasPos ? 3 : 2));
  if (spec.bad) process.exit(2);
  const idx = rules.findIndex(x => x.ch === ch && same(x.r, spec));
  if (op === "-C") process.exit(idx >= 0 ? 0 : 1);
  if (op === "-I") { if (has("fw-add-fails")) process.exit(1); rules.unshift({ ch, r: spec }); save(rules); process.exit(0); }
  if (op === "-D") { if (idx < 0) process.exit(1); rules.splice(idx, 1); save(rules); process.exit(0); }
  process.exit(1);
}
if (cmd[0] === "setpriv") {
  const uid = cmd.find(x => x.startsWith("--reuid=")).slice(8);
  const daemon = fs.readFileSync(F + "/daemon-uid", "utf8").trim();
  const target = (cmd.join(" ").match(/dev\\/tcp\\/([0-9.]+)\\//) || [])[1];
  if (target && target.startsWith("172.31.")) {
    fs.appendFileSync(F + "/calls", "nsenter " + a.join(" ") + "\\n");
    // a namespace that is still settling: the first N probes fail with a timeout, then they behave
    if (has("probe-flaky")) { const n = Number(fs.readFileSync(F + "/probe-flaky", "utf8")); if (n > 0) { fs.writeFileSync(F + "/probe-flaky", String(n - 1)); process.exit(124); } }
    if (has("store-dead")) process.exit(uid === daemon ? 1 : 124);
    if (uid === daemon) process.exit(0);
    const mine = (fs.existsSync(file) ? load() : []).filter(x => x.ch === "OUTPUT").map(x => x.r);
    const blocked = !has("fw-ineffective") && mine.some(r => r.d === "172.31.7.0/24" && r.uid && Number(uid) >= Number(r.uid.split("-")[0]) && Number(uid) <= Number(r.uid.split("-")[1]));
    process.exit(blocked ? 1 : 0);
  }
}
base();
`;

/** The Space helper's rig with the app fakes in front. @param {import("node:test").TestContext} t */
export function appRig(t) {
  const r = rig(t);
  const { F } = r;
  const BIN = path.join(F, "bin");
  for (const name of ["docker", "nsenter"]) {
    fs.renameSync(path.join(F, name + ".cjs"), path.join(F, name + "-base.cjs"));
    fs.writeFileSync(path.join(F, name + ".cjs"), (name === "docker" ? DOCKER_APP : NSENTER_APP).replaceAll("__F__", F).replaceAll("__REPO__", REPO));
    fs.writeFileSync(path.join(BIN, name), `#!/bin/sh\nexec node "${F}/${name}.cjs" "$@"\n`, { mode: 0o755 });
  }
  // the host's own iptables (the build network's rules in DOCKER-USER and INPUT): a list per chain, -C -I -D -S, logged with the other calls
  fs.writeFileSync(path.join(F, "hostfw.cjs"), `const fs=require("fs"),F=${JSON.stringify(F)};let a=process.argv.slice(2);if(a[0]==="-w")a=a.slice(1);
fs.appendFileSync(F+"/calls","iptables "+a.join(" ")+"\\n");const file=F+"/hostfw";let rules=[];try{rules=JSON.parse(fs.readFileSync(file,"utf8"))}catch{}
const op=a[0],ch=a[1];const pos=op==="-I"&&/^[0-9]+$/.test(a[2]);const rule=a.slice(pos?3:2).join(" ");const i=rules.findIndex(r=>r.ch===ch&&r.rule===rule);
if(op==="-C")process.exit(i>=0?0:1);
if(op==="-I"){if(fs.existsSync(F+"/hostfw-add-fails"))process.exit(1);rules.unshift({ch,rule});fs.writeFileSync(file,JSON.stringify(rules));process.exit(0)}
if(op==="-D"){if(i<0)process.exit(1);rules.splice(i,1);fs.writeFileSync(file,JSON.stringify(rules));process.exit(0)}
if(op==="-S"){process.stdout.write(rules.filter(r=>r.ch===ch).map(r=>"-A "+ch+" "+r.rule).join("\\n")+"\\n");process.exit(0)}
process.exit(0)`);
  for (const name of ["iptables", "ip6tables"]) fs.writeFileSync(path.join(BIN, name), `#!/bin/sh\nexec node "${F}/hostfw.cjs" "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(F, "daemon-uid"), String(process.getuid()));
  const priv = path.join(r.SP, "private");
  /** The host's iptables rules the build network added, as [{ ch, rule }]. */
  const hostFw = () => { try { return JSON.parse(fs.readFileSync(path.join(F, "hostfw"), "utf8")); } catch { return []; } };
  const appFw = (pid = "4242") => { try { return JSON.parse(fs.readFileSync(path.join(F, "appfw-" + pid), "utf8")); } catch { return []; } };
  /** An `app-up documents` request, run. */
  // the up-lane rate limit is the Space helper's own (six a minute, shared with Twenty's `up`); a test that asks for many ups lifts it
  const helper = () => r.run(["space-helper-run"], { VYRE_SPACES_UP_PER_MIN: "1000" });
  const appUp = async (m = "documents") => { const id = r.ask(`app-up ${m}\n`); const h = /** @type {any} */ (await helper()); return { id, h, st: r.status(id) }; };
  const catalogLine = () => fs.readFileSync(path.join(priv, "app-modules"), "utf8");
  return { ...r, helper, priv, appFw, hostFw, appUp, catalogLine, REPO };
}

/** A list line for the tests, with fields replaced by name. @param {Record<string, string>} [over] */
export function lineOf(over = {}) {
  const f = { name: "documents", image: "docuseal/docuseal:3.3.1@sha256:" + "e".repeat(64), port: "3000", mem: "1536", cpus: "1.5", pids: "512", hook: "43001", script: "docuseal-bootstrap.rb", exec: "bin/rails+runner", outs: "api_token+login_password", hpath: "/", hok: "200+302", hstart: "120", ...over };
  return Object.values(f).join(" ");
}
