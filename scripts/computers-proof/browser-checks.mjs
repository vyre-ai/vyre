// Step 3, browser half: through computerd's authenticated /cdp route (Vyre's own hands-chrome Cdp
// client), check that file:// and chrome:// are blocked and where a download lands.
//   node browser-checks.mjs <computerd-url> <token> <container-name>
// Prints one PASS/FAIL line per check with the evidence. Exit code 1 if any fails.
import { execFileSync } from "node:child_process";
import { Cdp } from "../../modules/hands-chrome/cdp.js";

const [url, token, container] = process.argv.slice(2);
const cdp = new Cdp({ cdpUrl: url.replace(/\/+$/, "") + "/cdp", token });
let failed = 0;
const say = (ok, name, evidence) => { if (!ok) failed = 1; console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${evidence}`); };
const sh = (user, cmd) => { try { return execFileSync("docker", ["exec", "-u", user, container, "sh", "-c", cmd], { encoding: "utf8" }).trim(); } catch (e) { return `ERR ${String(e.stderr || e.message).trim()}`; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

await cdp.connect();
const { targetInfos } = await cdp.send("Target.getTargets", {});
const pageInfo = targetInfos.find(t => t.type === "page") || (await (async () => {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  return { targetId };
})());
const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: pageInfo.targetId, flatten: true });
await cdp.send("Page.enable", {}, sessionId);
await cdp.send("Runtime.enable", {}, sessionId);

// 1. The agent asking for file:// and chrome:// through CDP: computerd refuses the call itself.
for (const u of ["file:///etc/passwd", "chrome://version", "devtools://devtools/bundled/inspector.html", "view-source:about:blank"]) {
  try { const r = await cdp.send("Page.navigate", { url: u }, sessionId); say(false, `cdp navigate ${u}`, `accepted: ${JSON.stringify(r)}`); }
  catch (e) { say(true, `cdp navigate ${u} refused by computerd`, e.message); }
}
try { await cdp.send("Target.createTarget", { url: "file:///etc/passwd" }); say(false, "cdp createTarget file://", "accepted"); }
catch (e) { say(true, "cdp createTarget file:// refused by computerd", e.message); }

// 2. Page script navigating itself to file:// / chrome:// (not a CDP call at all): Chrome's own
//    managed URLBlocklist must stop it. An about:blank page tries; then we read where it ended up.
await cdp.send("Page.navigate", { url: "about:blank" }, sessionId);
await sleep(800);
for (const u of ["about:blank#control", "file:///etc/passwd", "chrome://version"]) {
  const control = u.endsWith("#control");
  await cdp.send("Runtime.evaluate", { expression: `location.href = ${JSON.stringify(u)}`, returnByValue: true }, sessionId).catch(() => {});
  await sleep(1500);
  const r = await cdp.send("Runtime.evaluate", { expression: "JSON.stringify({url: location.href, title: document.title, body: (document.body && document.body.innerText || '').slice(0, 160)})", returnByValue: true }, sessionId).catch(e => ({ err: e.message }));
  const v = r && r.result && r.result.value ? JSON.parse(r.result.value) : { err: r && r.err };
  if (control) { say(/#control$/.test(v.url || ""), "positive control: a page script navigation to about:blank#control takes effect", JSON.stringify(v)); }
  else {
    const blocked = !/^(file|chrome):/.test(v.url || "") || /blocked|ERR_/i.test(`${v.title} ${v.body}`);
    say(blocked && !/root:x:0:0/.test(v.body || ""), `page script navigates to ${u}: Chrome policy blocks it`, JSON.stringify(v));
  }
  await cdp.send("Page.navigate", { url: "about:blank" }, sessionId).catch(() => {});
  await sleep(500);
}

// 3. Downloads. The agent may point them only at computerd's own folder; a download into the
//    agent's home is refused; a real download lands in that folder, readable by the agent uid.
try { await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: "/home/agent/Downloads" }); say(false, "cdp download path /home/agent/Downloads", "accepted"); }
catch (e) { say(true, "cdp download path /home/agent/Downloads refused", e.message); }
const dl = "/var/lib/vyre/browser/downloads";
try { await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dl }); say(true, `cdp download path ${dl} accepted`, "ok"); }
catch (e) { say(false, `cdp download path ${dl}`, e.message); }
const payload = Buffer.from("harlow legal proof download\n").toString("base64");
await cdp.send("Page.navigate", { url: `data:text/html,<a id=a download=csproof.txt href="data:text/plain;base64,${payload}">x</a>` }, sessionId);
await sleep(1200);
await cdp.send("Runtime.evaluate", { expression: "document.getElementById('a').click()", userGesture: true }, sessionId).catch(() => {});
let listing = "";
for (let i = 0; i < 20; i++) { await sleep(500); listing = sh("1000:1000", `ls -la ${dl} /home/agent/Downloads`); if (/csproof\.txt/.test(listing) && !/\.crdownload/.test(listing)) break; }
console.log("--- ls -la (download folder, then /home/agent/Downloads)\n" + listing);
const inFolder = sh("1000:1000", `ls ${dl}`).includes("csproof.txt");
const inHome = sh("1000:1000", "ls /home/agent/Downloads").includes("csproof.txt");
say(inFolder, `download landed in ${dl}`, inFolder ? "csproof.txt present" : "not there");
say(!inHome, "download did NOT land in /home/agent/Downloads (by design, see entrypoint.sh: the agent owns that folder)", inHome ? "present there" : "absent");
const asAgent = sh("1000:1000", `cat ${dl}/csproof.txt`);
say(asAgent.includes("harlow legal proof download"), "the agent uid can read the downloaded file", asAgent);
sh("1002:1002", `rm -f ${dl}/csproof.txt`);
process.exit(failed);
