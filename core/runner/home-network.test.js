// A home session's network (reviewer-2, Mac gap 3): the only way out is the per-session egress proxy in internet mode, public addresses only. The refusal matrix runs everywhere against
// the real proxy; on a hosted Mac the same is proved from INSIDE the real seatbelt profile (a direct connection fails, the proxy works, the proxy refuses the LAN and loopback).
import "../../scripts/mac-test-guard.mjs";
import "./testing/hosted-guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { SCRATCH } from "../../test/scratch.mjs";
import { startHomeProxy } from "./homeproxy.js";
import { planHome } from "./homesandbox.js";
import { launch } from "./sandbox.js";

const HOSTED = process.platform === "darwin" && process.env.VYRE_TEST_HOSTED === "1";
const connectVia = (port, token, target) => new Promise(res => {
  const s = net.connect(port, "127.0.0.1"); let b = "";
  s.on("connect", () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: Basic ${Buffer.from("vyre:" + token).toString("base64")}\r\n\r\n`));
  s.on("data", d => { b += d; if (b.includes("\r\n\r\n")) { s.destroy(); res(b.split("\r\n")[0]); } });
  s.on("error", e => res("error " + e.code)); setTimeout(() => { s.destroy(); res("timeout"); }, 4000);
});

test("the home proxy is internet mode: public addresses pass, loopback, the LAN, link-local, the cloud metadata address, this machine's own address and mail are refused, a wrong token is refused", async t => {
  const echo = net.createServer(c => c.end("pong")); await new Promise(r => echo.listen(0, "127.0.0.1", r)); t.after(() => echo.close());
  const hp = await startHomeProxy({ platform: process.platform === "linux" ? "darwin" : process.platform, lookup: async h => (h === "public.test" ? [{ address: "93.184.216.34" }] : h === "rebind.test" ? [{ address: "93.184.216.34" }, { address: "10.0.0.5" }] : [{ address: "127.0.0.1" }]), dial: (ip, port) => net.connect(echo.address().port, "127.0.0.1") });
  t.after(() => hp.stop());
  const { port, token } = /** @type {any} */ (hp.proxy);
  assert.match(await connectVia(port, token, "public.test:443"), /200/, "a public address through the proxy");
  for (const target of ["127.0.0.1:80", "[::1]:80", "192.168.1.10:80", "10.0.0.1:443", "172.16.0.9:443", "169.254.169.254:80", "100.100.100.100:443", "rebind.test:443", "localhost:80", "public.test:25", "public.test:465", "public.test:587"])
    assert.doesNotMatch(await connectVia(port, token, target), /200/, `${target} refused`);
  assert.doesNotMatch(await connectVia(port, "wrong-token", "public.test:443"), /200/, "a wrong token is refused");
});

test("macOS: from inside the home profile a direct connection to the internet fails, the proxy is the only way out, and it refuses the LAN and loopback", { skip: !HOSTED, timeout: 90_000 }, async t => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "hn-"))); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, "home"), proj = path.join(base, "proj"), temp = path.join(base, "temp"), run = path.join(home, ".vyre", "run");
  for (const d of [home, proj, temp, run]) fs.mkdirSync(d, { recursive: true });
  const sock = path.join(run, "s.sock"); const sv = net.createServer(c => c.end()); await new Promise(r => sv.listen(sock, r)); t.after(() => sv.close());
  const echo = net.createServer(c => c.end("pong")); await new Promise(r => echo.listen(0, "127.0.0.1", r)); t.after(() => echo.close());
  const hp = await startHomeProxy({ lookup: async h => (h === "public.test" ? [{ address: "93.184.216.34" }] : [{ address: "127.0.0.1" }]), dial: () => net.connect(echo.address().port, "127.0.0.1") });
  t.after(() => hp.stop());
  const { port, token } = /** @type {any} */ (hp.proxy);
  const script = `
    const net=require("net");const out={};const P=JSON.parse(process.argv[1]);
    const direct=(h,p)=>new Promise(res=>{const s=net.connect(p,h);const f=v=>{try{s.destroy()}catch{}res(v)};s.on("connect",()=>f("connected"));s.on("error",e=>f(e.code||"error"));setTimeout(()=>f("timeout"),2500)});
    const via=(t)=>new Promise(res=>{const s=net.connect(P.port,"127.0.0.1");let b="";s.on("connect",()=>s.write("CONNECT "+t+" HTTP/1.1\\r\\nHost: "+t+"\\r\\nProxy-Authorization: Basic "+Buffer.from("vyre:"+P.token).toString("base64")+"\\r\\n\\r\\n"));
      s.on("data",d=>{b+=d;if(b.includes("pong")||b.includes("403")||b.includes("407")||b.includes("502")){s.destroy();res(b.split("\\r\\n")[0])}});s.on("error",e=>res("error "+e.code));setTimeout(()=>{s.destroy();res("timeout")},4000)});
    (async()=>{out.direct=await direct("1.1.1.1",443);out.directDns=await direct("example.com",443);out.proxyPublic=await via("public.test:443");out.lan=await via("192.168.1.10:80");out.loop=await via("127.0.0.1:"+P.port);out.meta=await via("169.254.169.254:80");console.log(JSON.stringify(out))})();`;
  const p = planHome({ platform: "darwin", command: process.execPath, args: ["-e", script, JSON.stringify({ port, token })], home, vyreHome: path.join(home, ".vyre"), sessionSocket: sock, workdirs: [proj], temp, proxy: hp.proxy, readOnly: [path.dirname(process.execPath)] });
  const c = launch(p, { cwd: p.cwd }); let out = "", err = ""; c.stdout.on("data", d => out += d); c.stderr.on("data", d => err += d);
  await new Promise(r => c.on("close", r));
  assert.ok(!/sandbox-exec:/.test(err), `the profile was refused: ${err}`);
  const res = JSON.parse(out.trim().split("\n").pop());
  console.log("home network from inside the Mac profile:", JSON.stringify(res));
  assert.notEqual(res.direct, "connected", "a direct connection to 1.1.1.1 must fail");
  assert.notEqual(res.directDns, "connected", "a direct connection by name must fail");
  assert.match(res.proxyPublic, /pong|200/, "a public destination works through the proxy");
  for (const k of ["lan", "loop", "meta"]) assert.doesNotMatch(res[k], /pong|200/, `${k} refused by the proxy`);
});
