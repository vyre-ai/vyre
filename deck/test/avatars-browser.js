// @ts-check
// A real-Chrome check of the four avatar families (js/avatars.js, ADR 0043), on testbox only:
//
//   node deck/test/avatars-browser.js [--port 4796] [--out <dir>]
//
// It starts the native bar's world (temp home, this tree's vyred, fake claude and tailscale,
// VYRE_NO_DIALOGS=1) and one headless Chrome with a temp profile, then checks: a gallery of the
// four families at every size draws real, non-empty SVG in Dark and Paper, with every gradient
// reference resolving to exactly one element on the page; the person's Vyre code ring draws at
// Settings > You size; a chat session draws the person and assistant avatars in its rows and the
// header; a tap plays the hop and Reduce Motion keeps it still. It prints one JSON line per check
// and saves a screenshot of each. Synthetic fingerprints only. A test helper, not part of the product.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openTab } from "./cdp.js";
import { SCRATCH } from "../../test/scratch.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (/** @type {string} */ n, /** @type {string} */ d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(arg("--port", "4796"));
const OUT = path.resolve(arg("--out", fs.mkdtempSync(path.join(SCRATCH, "avatar-shots-"))));
fs.mkdirSync(OUT, { recursive: true });
const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));
/** @type {import("node:child_process").ChildProcess[]} */ const started = [];
const scratch = fs.mkdtempSync(path.join(SCRATCH, "avatar-chrome-"));
let failed = 0;
const say = (/** @type {string} */ check, /** @type {boolean} */ pass, detail = "") => { if (!pass) failed++; process.stdout.write(JSON.stringify({ check, pass, ...(detail ? { detail } : {}) }) + "\n"); };
async function stopAll() {
  for (const p of started.reverse()) { try { p.kill("SIGTERM"); } catch {} }
  await sleep(1500);
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
}

// A made-up owner: fingerprints are sha256 of the ADR's prefixes over this id, first 8 bytes.
const crypto = await import("node:crypto");
const OWNER_ID = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const fp = (/** @type {string} */ prefix) => crypto.createHash("sha256").update(prefix + OWNER_ID).digest("hex").slice(0, 16);
const IDENTITY = { owner: { name: "alex", fingerprint8: fp("vyre:person:v1:") }, assistant: { name: "juno", fingerprint8: fp("vyre:assistant:v1:") } };

/** Draws the gallery into a fixed overlay and reports what the browser made of it. */
const GALLERY = `
  const av = await import("/js/avatars.js");
  av.setIdentity(${JSON.stringify(IDENTITY)});
  av.setTeammates(["design-harlow-legal", "docs-harlow-legal", "reviewer-northwind", "qa-northwind"]);
  document.getElementById("av-gallery")?.remove();
  const g = document.createElement("div");
  g.id = "av-gallery";
  g.style.cssText = "position:fixed;inset:0;z-index:9999;background:var(--bg);color:var(--text);padding:20px;overflow:auto;font:13px/18px sans-serif";
  const line = (label, els) => { const r = document.createElement("div"); r.style.cssText = "display:flex;align-items:center;gap:12px;margin:8px 0"; const l = document.createElement("span"); l.style.width = "90px"; l.textContent = label; r.append(l, ...els); g.append(r); };
  const sizes = [24, 32, 40, 56];
  line("person", sizes.map(s => av.personAvatar({ size: s })));
  line("assistant", sizes.map(s => av.assistantAvatar({ size: s })));
  for (const a of ["kit", "scout", "glass", "planner", "relay"]) line("agent " + a, sizes.map(s => av.agentAvatar(a, { size: s })));
  for (const t of ["design-harlow-legal", "docs-harlow-legal", "reviewer-northwind", "qa-northwind", "memory-northwind", "chat-harlow-legal", "sessions-alex", "research-alex"]) line(t, sizes.map(s => av.teammateAvatar(t, { size: s })));
  line("you, ring", [av.personAvatar({ size: 160, ring: true, label: "Your avatar, alex" })]);
  document.body.append(g);
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const svgs = [...g.querySelectorAll(".vy-av > svg")];
  const empty = svgs.filter(s => { const b = s.getBoundingClientRect(); return !(b.width > 0 && b.height > 0) || !s.querySelector("path,circle,rect,line"); }).length;
  const ids = [...document.querySelectorAll("svg [id]")].map(e => e.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  const refs = [...g.querySelectorAll("[fill^='url(#'],[stroke^='url(#']")].map(e => (e.getAttribute("fill") || e.getAttribute("stroke")).slice(5, -1));
  const broken = refs.filter(id => document.querySelectorAll("#" + CSS.escape(id)).length !== 1);
  const families = [...g.querySelectorAll(".vy-av")].reduce((m, e) => (m[e.dataset.family] = (m[e.dataset.family] || 0) + 1, m), {});
  const ring = !!g.querySelector(".vy-av-ring svg[viewBox='0 0 600 600']");
  const shapes = { person: getComputedStyle(g.querySelector(".vy-av-person")).borderRadius, teammate: getComputedStyle(g.querySelector(".vy-av-teammate")).borderRadius };
  return { svgs: svgs.length, empty, dupes: dupes.length, refs: refs.length, broken, families, ring, shapes };`;

try {
  const w = spawn("nice", ["-n", "15", process.execPath, path.join(HERE, "native-bar", "world.js"), "--port", String(PORT)], { stdio: ["ignore", "pipe", "inherit"] });
  started.push(w);
  /** @type {{ url: string, s40: string }} */
  const world = await new Promise((resolve, reject) => {
    let buf = "";
    w.stdout?.on("data", d => { buf += d; const l = buf.split("\n").find(x => x.startsWith("{")); if (l) resolve(JSON.parse(l)); });
    w.once("exit", c => reject(new Error(`world exited ${c}`)));
    setTimeout(() => reject(new Error("world did not come up in 120 s")), 120_000);
  });
  const bin = process.env.CHROME || path.join(os.homedir(), "vyre-ci/pwa-chrome/chrome-headless-shell/linux-154.0.8037.57/chrome-headless-shell-linux64/chrome-headless-shell");
  const cdpPort = 9431 + Math.floor(Math.random() * 400);
  const chrome = spawn("nice", ["-n", "15", bin, `--remote-debugging-port=${cdpPort}`, "--remote-debugging-address=127.0.0.1", `--user-data-dir=${scratch}`,
    "--no-sandbox", "--no-first-run", "--window-size=1280,900", "about:blank"], { stdio: "ignore" });
  started.push(chrome);
  const CDP = `http://127.0.0.1:${cdpPort}`;
  for (let i = 0; i < 100; i++) { try { await fetch(`${CDP}/json/version`); break; } catch { await sleep(200); } }
  const tab = await openTab(CDP, { width: 1280, height: 900, scale: 1, mobile: false });
  const shot = async (/** @type {string} */ name) => {
    await sleep(300);
    const r = await tab.send("Page.captureScreenshot", { format: "png" });
    if (r.result?.data) fs.writeFileSync(path.join(OUT, name + ".png"), Buffer.from(r.result.data, "base64"));
  };

  // 1. The gallery, Dark then Paper.
  await tab.go(`${world.url}/settings`, 2500);
  for (const theme of ["dark", "paper"]) {
    await tab.run(`if (${JSON.stringify(theme)} === "paper") document.documentElement.dataset.theme = "paper"; else delete document.documentElement.dataset.theme; return true;`);
    const g = await tab.run(GALLERY);
    say(`${theme}: every avatar draws real SVG`, g.svgs >= 60 && g.empty === 0, `${g.svgs} drawn, ${g.empty} empty; ${JSON.stringify(g.families)}`);
    say(`${theme}: gradient ids unique, every reference resolves once`, g.dupes === 0 && g.broken.length === 0, `${g.refs} references, ${g.dupes} duplicate ids, broken: ${g.broken.slice(0, 3).join(",")}`);
    say(`${theme}: the person's Vyre code ring at Settings size`, g.ring);
    say(`${theme}: shapes (person a circle, teammate a tile)`, /9999|50%/.test(g.shapes.person) && g.shapes.teammate !== "0px", JSON.stringify(g.shapes));
    await shot(`gallery-${theme}`);
  }
  await tab.run(`document.getElementById("av-gallery")?.remove(); delete document.documentElement.dataset.theme; return true;`);

  // 2. Settings > You: your own avatar, large.
  await tab.go(`${world.url}/settings#you`, 2500);
  const you = await tab.run(`await waitFor(".set-you-av .vy-av", 10000); const e = document.querySelector(".set-you-av .vy-av"); e.scrollIntoView({ block: "center" }); const b = e.getBoundingClientRect(); return { w: b.width, family: e.dataset.family, ring: e.classList.contains("vy-av-ring") };`);
  say("Settings > You draws your avatar large", you.family === "person" && you.w >= 150, `${you.w}px, ring ${you.ring} (the ring needs owner.fingerprint8 from system.info)`);
  await shot("settings-you");

  // 3. A chat session: the person's and the assistant's avatars in the rows, and the header.
  await tab.go(`${world.url}/chat/thread/${encodeURIComponent(world.s40)}`, 3000);
  const chat = await tab.run(`await waitFor(".cv-user .vy-av", 15000); return {
    user: document.querySelector(".cv-user .vy-av")?.dataset.family, head: document.querySelector(".cv-head .vy-av")?.dataset.family,
    header: document.querySelector(".cv-head-av")?.dataset.family, drawn: [...document.querySelectorAll(".cv-row .vy-av svg")].length };`);
  say("chat rows and header draw the families", chat.user === "person" && chat.head === "assistant" && chat.header === "assistant" && chat.drawn > 0, JSON.stringify(chat));
  await shot("chat-session");

  // 4. A tap hops; Reduce Motion keeps it still.
  const tap = () => tab.run(`const e = document.querySelector(".cv-user .vy-av"); e.classList.remove("vy-av-play"); e.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const on = e.classList.contains("vy-av-play"); const anim = getComputedStyle(e).animationName; return { on, anim };`);
  const moving = await tap();
  say("a tap on an avatar plays the hop", moving.on && moving.anim === "vy-av-hop", JSON.stringify(moving));
  await tab.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const still = await tap();
  say("Reduce Motion: no hop", !still.on, JSON.stringify(still));

  say("no page errors", tab.errors.length === 0, tab.errors.slice(0, 3).join(" | "));
  process.stdout.write(JSON.stringify({ shots: OUT }) + "\n");
} catch (e) {
  say("ran", false, String(/** @type {Error} */ (e).stack || e));
} finally {
  await stopAll();
  process.exit(failed ? 1 : 0);
}
