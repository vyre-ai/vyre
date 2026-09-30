// @ts-check
// `vyre connect apps` and `vyre connect add app <preset>`: the catalog of apps whose vendor runs its
// own hosted MCP server, and the one connect flow (core/connectors). Like the Google sign-in in
// connect.js, this is a conversation with a browser and a terminal: it prints the vendor's sign-in
// address, waits for the browser to come back (or for the address pasted here), and says what came
// of it. A token is typed at a hidden prompt, never taken on the command line.

import readline from "node:readline";
import { call } from "../../daemon/client.js";
import { flags, hiddenPrompt, visiblePrompt } from "../../vault/cli-io.js";
import { out, dim, bold, signal, beacon } from "../style.js";
import { json, emit, usage } from "../kit.js";
import { follow, fail, oops, grant, openBrowser, PASTE_HINT, SIGN_IN_WAIT_MS } from "./connect.js";

const SETUP = { none: "sign in", app: "your own app", token: "a token", via: "its own sign-in" };

/** @param {string[]} args */
export async function apps(args) {
  let f;
  try { f = flags(args, { boolean: ["all"], string: ["group"] }); } catch (e) { return oops(/** @type {Error} */ (e).message); }
  const r = await call("connectors.catalog", { ...(f.all ? { all: true } : {}), ...(f.group ? { group: f.group } : {}) });
  if (r.error) return fail(r);
  const { presets, unavailable = [] } = r.data;
  if (json()) return emit(r.data);
  out("");
  for (const p of presets) {
    const on = p.connected.length ? signal(`connected ${p.connected.map(c => c.name).join(", ")}`) : dim(SETUP[p.setup] || p.setup);
    out(`  ${bold(p.id.padEnd(16))} ${p.label}  ${on}`);
    out(dim(`      ${p.who}${p.note ? " " + p.note : ""}`));
  }
  for (const u of unavailable) out(dim(`  ${u.id.padEnd(16)} ${u.label}  cannot be connected: ${u.reason}`));
  out(dim("\n  vyre connect add app <id> connects one. A second account: --label <name>.\n"));
  return 0;
}

/**
 * @param {string | undefined} preset @param {string[]} args
 */
export async function addApp(preset, args) {
  if (!preset || preset.startsWith("-")) return usage("vyre connect add app <preset>", "vyre connect apps lists them");
  let f;
  try { f = flags(args, { string: ["label", "mode", "client", "name"], boolean: ["replace"] }); } catch (e) { return oops(/** @type {Error} */ (e).message); }
  if (f._.length) return oops(`unexpected ${f._[0]}`);
  const ask = { preset, ...(f.label ? { label: f.label } : {}), ...(f.name ? { name: f.name } : {}), ...(f.mode ? { mode: f.mode } : {}),
    ...(f.client ? { client: f.client } : {}), ...(f.replace ? { replace: true } : {}) };

  let r = await call("connectors.connect", ask, { timeout: 60_000 });
  if (r.error) return fail(r);
  let a = r.data;

  if (a.step === "needs" && a.needs === "token") {
    if (json() || !process.stdin.isTTY) return usage(`${a.label} needs a token, typed at a hidden prompt`, `run vyre connect add app ${preset} in a terminal`);
    out(dim(`  ${a.help}`));
    showGuide(a.guide);
    const token = await hiddenPrompt(`  ${a.label}: `);
    /** @type {Record<string, string>} */ const extra = {};
    for (const x of a.extra || []) {
      const v = await visiblePrompt(`  ${x.label}${x.required ? "" : " (optional)"}: `);
      if (v) extra[x.name] = v;
    }
    r = await call("connectors.connect", { ...ask, mode: "token", token, ...(Object.keys(extra).length ? { extra } : {}) }, { timeout: 90_000 });
    if (r.error) return fail(r);
    a = r.data;
  }

  if (a.step === "needs") {
    // The person's own OAuth app: the guide, then its client ID and secret typed here.
    out(beacon(`  ${preset} needs your own OAuth app first`));
    out(dim(`  ${a.help}`));
    showGuide(a.guide);
    if (a.redirect) out(dim(`  Its redirect address is ${a.redirect}`));
    if (json() || !process.stdin.isTTY) {
      out(dim(`  Run vyre connect add app ${preset} in a terminal to enter its client ID and secret.`));
      return 1;
    }
    const id = (await visiblePrompt("  Client ID: ")).trim();
    if (!id) return oops("no client ID entered; nothing stored");
    const secret = await hiddenPrompt("  Client secret (Enter to skip if it has none): ");
    r = await call("connectors.connect", { ...ask, app: { client_id: id, ...(secret ? { client_secret: secret } : {}) } }, { timeout: 60_000 });
    if (r.error) return fail(r);
    a = r.data;
    if (a.step === "needs") return oops(a.help);
  }
  if (a.step === "via") { out(`  ${a.message}`); return 0; }
  if (a.step === "connected") return connected(a);

  // step "open": the sign-in address, then wait for the browser
  if (f.client && !(await grant([f.client], "connectors")).ok) { await call("connectors.connect.cancel", { id: a.id }); return 1; }
  if (a.redirect && a.redirect.startsWith("https:")) out(dim("  Your browser will show a page that cannot load after you allow it. That is expected: copy the full address from the browser bar and paste it here."));
  if (json()) return usage(`vyre connect add app ${preset} is a conversation with a browser; run it in a terminal, without --json`, `vyre connect add app ${preset}`);
  return waitForBrowser(a);
}

/** Steps and links from a preset's guide, plain. @param {any} g */
function showGuide(g) {
  if (!g) return;
  out("");
  for (const [i, step] of (g.steps || []).entries()) out(`  ${i + 1}. ${step}`);
  for (const l of g.links || []) out(`  ${dim(l.label + ":")} ${l.url}`);
  out("");
}

/** @param {any} a */
function connected(a) {
  if (json()) { emit(a); return 0; }
  out(`  ${signal("connected")} ${bold(a.name)} ${dim(a.tools === undefined ? "" : `${a.tools} tools`)}`);
  if (a.warning) out(beacon(`  ${a.warning}`));
  return 0;
}

/** @param {{ id: string, url: string, name: string }} a */
async function waitForBrowser(a) {
  /** @type {(v: { ok: true, tools?: number } | { ok: false, error: string, cancelled?: boolean }) => void} */
  let settle = () => {};
  const ended = new Promise(r => { settle = r; });
  const seen = e => {
    const p = e.payload ?? e.data ?? {};
    if (p.id !== a.id) return;
    if (e.type === "connectors.connected") settle({ ok: true });
    else if (e.type === "connectors.connect-failed") settle({ ok: false, error: String(p.error || "the sign-in failed") });
  };
  const stream = await follow(seen, "connectors.*");
  if ("error" in stream) { await call("connectors.connect.cancel", { id: a.id }); return stream.error === "unreachable" ? fail({ error: { code: "unreachable", message: "" } }) : oops(stream.error); }

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  let finishing = false, said = "";
  /** @type {any} */ let landed = null;
  rl.on("line", async line => {
    const text = line.trim();
    if (!text) return;
    if (!/^https?:\/\/\S+$/.test(text)) { out(dim("  that is not an address; paste the whole address from the browser, starting with http")); return; }
    if (finishing) return;
    finishing = true;
    const f = await call("connectors.connect.finish", { id: a.id, url: text }, { timeout: 90_000 });
    finishing = false;
    if (f.error && f.error.code !== "not_found") { said = f.error.message; out(beacon(`  ${said}`)); }
    else if (!f.error) { landed = f.data; settle({ ok: true }); }
  });
  const stop = () => settle({ ok: false, error: "cancelled, nothing stored", cancelled: true });
  rl.on("close", () => { if (process.stdin.isTTY) stop(); });
  process.on("SIGINT", stop);
  const timer = setTimeout(() => settle({ ok: false, error: "the sign-in expired after 10 minutes; nothing stored", cancelled: true }), SIGN_IN_WAIT_MS);

  out("");
  out(a.url);
  out("");
  openBrowser(a.url);
  out(dim(`  ${PASTE_HINT}`));

  const result = await ended;
  clearTimeout(timer);
  process.off("SIGINT", stop);
  rl.removeAllListeners("line");
  rl.close();
  process.stdin.destroy();
  stream.close();
  if (!result.ok) {
    if (result.cancelled) await call("connectors.connect.cancel", { id: a.id });
    if (result.error !== said) out(beacon(`  ${result.error}`));
    return 1;
  }
  if (landed) return connected(landed);
  // The browser came back to the loopback: the module finished the connection on its own.
  const t = await call("mcp.test", { name: a.name }, { timeout: 60_000 });
  return connected({ name: a.name, ...(t.data && Array.isArray(t.data.tools) ? { tools: t.data.tools.length } : {}), ...(t.data && t.data.ok === false ? { warning: t.data.error } : {}) });
}
