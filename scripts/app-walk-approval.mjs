#!/usr/bin/env node
// app-walk-approval: the app's own ask-the-phone code (apps/app/src/real/approvals.js heldAsk and askYes) against a real vyred, answered by a STAND-IN PHONE (scripts/standin-phone.mjs). TEST ONLY.
//
//   node scripts/app-walk-approval.mjs --socket <home>/.vyre/vyred.sock [--timeout]
//
// The home must be a development build enrolled with scripts/dev-enrol-software-key.mjs, started with VYRE_SEAL_DEV=1 VYRE_SEAL_SOFTWARE=1 and WITHOUT VYRE_KERNEL_FILE_KEY, and hold one vault item. The asker is the caller
// `deck` with no person session and no proof, exactly what a browser is: a vault reveal answers presence_required, heldAsk turns that into the card, askYes opens it (approvals.ask) and waits (approvals.status), the
// stand-in phone (caller `local`) answers. Steps: (1) yes: the card opens and the phone approves (the sealing process verifies its software-key proof); spending the approval needs a paired device and is not walked; (2, with --timeout) nobody answers and the card runs out (5 minutes); (3) no: askYes ends "refused" with the app's own words. A no holds the asker off for ten minutes, so it runs last.
// It does NOT draw the page: the browser hides Reveal on purpose in RC1 (screens/vault/RealVault.tsx), so no screen starts this flow for a vault item yet. Exit 0 when nothing failed.
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { askYes, endLine, heldAsk } from "../apps/app/src/real/approvals.js";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const SOCKET = flag("--socket", "");
const SLOW = args.includes("--timeout");
if (!SOCKET) { console.error("app-walk-approval: give --socket <home>/.vyre/vyred.sock"); process.exit(2); }
const HOME = path.dirname(SOCKET);
const here = path.dirname(fileURLToPath(import.meta.url));

/** One tool call as the browser (caller deck). Resolves { data } or { error }. @param {string} tool @param {any} input @param {Record<string, string>} [headers] */
const box = (tool, input = {}, headers = {}) => new Promise((resolve) => {
  const body = JSON.stringify(input);
  const r = http.request({ socketPath: SOCKET, path: `/v1/tools/${tool}`, method: "POST", headers: { host: "localhost", "x-vyre-caller": "deck", "content-type": "application/json", "content-length": Buffer.byteLength(body), ...headers } }, (x) => { let s = ""; x.on("data", (c) => (s += c)); x.on("end", () => { try { resolve(JSON.parse(s)); } catch { resolve({ error: { code: "bad_reply", message: s.slice(0, 100) } }); } }); });
  r.on("error", (e) => resolve({ error: { code: "unreachable", message: String(e.message) } })); r.end(body);
});
/** The app's call: the data, or an error with the box's code. */
const call = async (t, i) => { const x = await box(t, i); if (x.error) throw Object.assign(new Error(x.error.message), { code: x.error.code }); return x.data; };

const list = await box("vault.list");
const item = list.data?.items?.[0];
if (!item) { console.error("app-walk-approval: the box holds no vault item to reveal"); process.exit(2); }
const input = { name: item.name };

function phone(answer, seconds) {
  const p = spawn(process.execPath, [path.join(here, "standin-phone.mjs"), "--home", HOME, "--answer", answer, "--seconds", String(seconds), "--once"], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
  return { kill: () => p.kill(), done: new Promise((r) => p.on("exit", (code) => r({ code, line: out.trim().split("\n")[0] ? JSON.parse(out.trim().split("\n")[0]) : null, err: err.trim() }))) };
}

const results = [];
const check = async (name, fn) => {
  try { const note = await fn(); results.push({ name, ok: true }); console.log(`PASS ${name}${note ? ` | ${note}` : ""}`); }
  catch (e) { results.push({ name, ok: false, why: String(e.message).slice(0, 300) }); console.log(`FAIL ${name}: ${String(e.message).slice(0, 300)}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

/** The reveal as a browser makes it, asking the phone when the box says presence_required. */
async function asRevealing(answer, phoneSeconds, limitMs) {
  const first = await box("vault.reveal", input);
  assert(first.error?.code === "presence_required", `the first reveal should answer presence_required, got ${JSON.stringify(first).slice(0, 160)}`);
  const held = heldAsk(first.error, "vault.reveal", input);
  assert(held && held.moment === "vault", "the app did not turn presence_required into a vault card");
  const ph = phone(answer, phoneSeconds);
  let waiting = "";
  const out = await askYes(call, { moment: held.moment, request: held.request, onWaiting: (l) => { waiting = l; }, pollMs: 500, limitMs });
  const said = await ph.done;
  return { out, waiting, said };
}

await check("yes: the card opens, the stand-in phone approves, the reveal is sent again with the approval", async () => {
  const { out, waiting, said } = await asRevealing("yes", 60, 60000);
  assert("approval" in out, `not approved: ${JSON.stringify(out)} ${said.err}`);
  assert(/show "/.test(waiting), `the card's line was not shown: ${waiting}`);
  assert(said.line && said.line.result?.answered === "approved", `the phone did not say approved: ${JSON.stringify(said)}`);
  // The card is approved and verified by the sealing process. Spending it is NOT walked: the box reads an approval only from a paired DEVICE caller (core/modules/index.js, and the card redeemer checks the device),
  // and a walk with the relay off has no paired browser. So the retry below is expected to stay refused here; with a paired browser it is the step to add.
  const again = await box("vault.reveal", input, { "x-vyre-approval": out.approval });
  assert(again.error, "a caller that is not the asking device spent the card");
  return `line: ${waiting}; spending needs a paired device (not walked): ${again.error.code}`;
});
if (SLOW) await check("timeout: nobody answers and the card runs out", async () => {
  const { out } = await asRevealing("ignore", 330, 340000);
  assert("ended" in out && ["timeout", "none"].includes(out.ended), `expected the card to run out, got ${JSON.stringify(out)}`);
  return endLine(out.ended);
});
await check("no: the stand-in phone says no and the app says so", async () => {
  const { out, said } = await asRevealing("no", 60, 60000);
  assert("ended" in out && out.ended === "refused", `expected refused, got ${JSON.stringify(out)} ${said.err}`);
  assert(endLine(out.ended) === "You said no on your phone. Nothing changed.", "the app's words changed");
  return endLine(out.ended);
});
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length} pass, ${failed.length} fail`);
process.exit(failed.length ? 1 : 0);
