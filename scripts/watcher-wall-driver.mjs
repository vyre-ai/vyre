// The vyred side of scripts/watcher-wall-proof.sh, run inside the box container as uid vyre:
//   node watcher-wall-driver.mjs probe   one watcher child tries what the wall must stop; prints its JSON answer
//   node watcher-wall-driver.mjs two     two children at once; prints both answers on one line each
// It uses the same client call vyred's spawner wall candidate uses (spawnAsWatcher, argv[0] is node).
import net from "node:net";
import { spawnAsWatcher } from "/opt/vyre/core/spawner/client.js";

const CHILD = `
const net = require("net"), fs = require("fs");
const tcp = (h, p) => new Promise(r => { const s = net.connect(p, h); s.on("connect", () => r("connected")); s.on("error", e => r(e.code)); setTimeout(() => r("timeout"), 3000); });
const unix = p => new Promise(r => { const s = net.connect(p); s.on("connect", () => r("connected")); s.on("error", e => r(e.code)); setTimeout(() => r("timeout"), 3000); });
const can = f => { try { f(); return "yes"; } catch (e) { return e.code; } };
(async () => {
  console.log(JSON.stringify({
    uid: process.getuid(), groups: process.getgroups(), capBnd: (require("fs").readFileSync("/proc/self/status", "utf8").match(/^CapBnd:\\s*([0-9a-f]+)/m) || [])[1], env: Object.keys(process.env).sort(),
    loopback: await tcp("127.0.0.1", Number(process.argv[1])), public: await tcp("1.1.1.1", 443), unix: await unix("/run/vyre/spawner.sock"),
    work: can(() => fs.readdirSync("/work")), vyreHome: can(() => fs.readdirSync("/home/vyre")), vault: can(() => fs.readdirSync("/var/lib/vyre-secrets")),
    ownHome: can(() => fs.writeFileSync(process.env.HOME + "/note", "x")),
  }));
  if (process.argv.includes("--hold")) await new Promise(r => setTimeout(r, 4000));
})();
`;

// A real listener on the loopback, so a refusal means the wall and not an empty port; it must see no connection.
let seen = 0;
const listener = net.createServer(s => { seen++; s.destroy(); });
await new Promise(r => listener.listen(0, "127.0.0.1", () => r(undefined)));
const port = listener.address().port;

const run = async hold => {
  const p = await spawnAsWatcher(["/usr/local/bin/node", "-e", CHILD, String(port), ...(hold ? ["--hold"] : [])], {});
  let out = "", err = "";
  p.stdout.setEncoding("utf8"); p.stderr.setEncoding("utf8");
  p.stdout.on("data", d => (out += d)); p.stderr.on("data", d => (err += d));
  const code = await new Promise(r => p.once("exit", c => r(c)));
  const line = out.trim();
  if (!line) return `no output (exit ${code}): ${err.trim().slice(0, 200)}`;
  try { return JSON.stringify({ ...JSON.parse(line), listenerSaw: seen }); } catch { return line; }
};
try {
  if (process.argv[2] === "two") { const all = await Promise.all([run(true), run(true)]); console.log(all.join("\n")); }
  else console.log(await run(false));
} catch (e) { console.log(`REFUSED ${e.message}`); }
listener.close();
