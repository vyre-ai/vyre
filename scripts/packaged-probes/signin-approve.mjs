// Run INSIDE a development-kind box's container, as uid 1000, after scripts/dev-enrol-software-key.mjs enrolled the owner's software key and the daemon runs with VYRE_SEAL_DEV=1 VYRE_SEAL_SOFTWARE=1
// (scripts/rc-update-proof.sh, step 5): the whole `vyre signin` ask-and-approve loop with a signed proof, then a presence-needing call from the signed-in terminal.
//   node signin-approve.mjs <package root>
// Prints one line per stage and exits 0 only when the terminal signed in and a call that needs the person answered as the person.
import { spawn, spawnSync } from "node:child_process";
const root = process.argv[2] || "/opt/vyre", home = process.env.VYRE_HOME || "/home/vyre/.vyre";
const { call } = await import(`${root}/core/daemon/client.js`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const say = m => process.stdout.write(`signin-approve: ${m}\n`);
const die = m => { say("FAILED " + m); process.exit(1); };

const si = spawn(process.execPath, [`${root}/bin/vyre`, "signin", "--json"], { env: process.env });
let out = "", err = "";
si.stdout.on("data", d => { out += d; }); si.stderr.on("data", d => { err += d; });
const closed = new Promise(r => si.on("close", c => r(c)));

let card = null, last = null;
for (let i = 0; i < 40 && !card; i++) {
  await sleep(1000);
  last = await call("signin.pending", {}, { caller: "deck" });
  if (last && last.data && last.data.id) card = last.data;
}
if (!card) die(`no sign-in waiting for the owner after the ask (pending answered ${JSON.stringify(last)}; the command said: ${out.trim()} ${err.trim()})`);
say(`the ask reached the owner: op ${card.op}`);
const p = spawnSync(process.execPath, [`${root}/scripts/dev-sign-proof.mjs`, "--home", home, "--op", card.op, "--fields", JSON.stringify(card.fields), "--header"], { encoding: "utf8" });
if (p.status !== 0) die(`could not sign the card: ${p.stderr}`);
const ans = await call("signin.answer", { id: card.id, approve: true }, { caller: "deck", headers: { "x-vyre-kernel-proof": p.stdout.trim() } });
if (!ans || ans.error) die(`the signed answer was refused: ${JSON.stringify(ans)}`);
say("the owner's signed answer was accepted");
const code = await Promise.race([closed, sleep(60_000).then(() => "timeout")]);
if (code !== 0) die(`vyre signin did not finish signed in (exit ${code}): ${out.trim()} ${err.trim()}`);
say("vyre signin finished: this terminal is signed in");
// A call only the person may make, from the signed-in terminal (a plain terminal got "no kernel chain" for it).
// With a tool and input after the root (node signin-approve.mjs <root> <tool> <json>), that call is the one made from the signed-in terminal and its text follows a RESULT line (the proof reads and writes records this way).
const [tool = "memory.me", input = "{}"] = process.argv.slice(3);
const me = spawnSync(process.execPath, [`${root}/bin/vyre`, "call", tool, input], { encoding: "utf8", env: process.env });
if (process.argv[3]) { process.stdout.write("RESULT:\n" + me.stdout + me.stderr); process.exit(me.status === 0 ? 0 : 1); }
if (/no kernel chain|caller_unknown|denied/.test(me.stdout + me.stderr)) die(`after signin memory.me is still refused: ${(me.stdout + me.stderr).trim().slice(0, 300)}`);
say("a person-only call (memory.me) answers after signin");
