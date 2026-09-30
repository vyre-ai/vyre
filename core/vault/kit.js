// @ts-check
// kit: the recovery kit, a page a person prints once and keeps (ADR 0006, decision 5).
//
// The kit holds the Secret Key, which with the password opens the account on a new device. So
// the page is built to exist for as short a time, in as few places, as it can:
//   - It is served from memory on a random loopback port, under a random path token, and only
//     to a Host header naming that loopback address (a DNS-rebinding page gets nothing).
//   - It is served once. The first load ends it, and so do ten minutes. The server closes after.
//   - The Secret Key is asked for at load time, not before, and is never written to disk, a log,
//     an event or an audit row. The password is never on it: there is a line to write it on.
//   - The response says no-store, and a CSP of default-src 'none' means the page loads nothing
//     and runs nothing: no fonts, no scripts, no request anywhere while a secret is on screen.

import crypto from "node:crypto";
import http from "node:http";
import { canonical } from "./crypto.js";
import { encode, toSvg } from "./qr.js";

const TTL_MS = 10 * 60_000;

/** What goes in the QR code: `vyre-kit:v1:` and canonical JSON, so a scan restores in one step. */
export function kitPayload({ acct, sk, relay, fp }) {
  return "vyre-kit:v1:" + canonical({ acct: acct || "", sk, relay: relay || "", fp });
}

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] || c);

/**
 * The page. Paper palette from docs/design/TOKENS.md; system fonts, since the page loads nothing.
 * @param {{ name: string, acct?: string, sk: string, fp: string, relay?: string|null, created: number }} k
 */
export function kitPage(k) {
  const qr = toSvg(encode(kitPayload({ acct: k.acct, sk: k.sk, relay: k.relay || "", fp: k.fp })).modules, { px: 4 });
  const row = (label, value, cls = "") => `<div class="row"><div class="label">${esc(label)}</div><div class="value ${cls}">${value}</div></div>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Vyre recovery kit</title>
<style>
:root { --paper: #F4F1EA; --paper-raised: #FBFAF6; --paper-rule: #DCD7CC; --paper-rule-strong: #C9C3B7; --ink: #141311; --ink-2: #4A463F; --ink-3: #6B665D; --beacon-deep: #5B3FC4; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink); font: 15px/22px 'Instrument Sans', 'Helvetica Neue', Arial, sans-serif; }
main { max-width: 760px; margin: 32px auto; padding: 40px; background: var(--paper-raised); border: 1px solid var(--paper-rule); }
h1 { font-size: 28px; line-height: 34px; font-weight: 600; letter-spacing: -0.02em; margin: 0 0 4px; }
.sub { color: var(--ink-2); margin: 0 0 28px; }
.grid { display: grid; grid-template-columns: 1fr auto; gap: 32px; align-items: start; }
.row { padding: 12px 0; border-top: 1px solid var(--paper-rule); }
.label { font: 500 11px/14px 'JetBrains Mono', ui-monospace, Menlo, monospace; text-transform: uppercase; letter-spacing: 0.16em; color: var(--ink-3); margin-bottom: 4px; }
.value { font: 400 13px/20px 'JetBrains Mono', ui-monospace, Menlo, monospace; word-break: break-all; }
.value.key { font-size: 18px; line-height: 26px; font-weight: 500; letter-spacing: 0.02em; }
.blank { height: 40px; border-bottom: 1px solid var(--ink); }
.qr svg { display: block; width: 216px; height: 216px; }
.qr p { font-size: 13px; line-height: 18px; color: var(--ink-3); margin: 8px 0 0; max-width: 216px; }
ol { padding-left: 20px; margin: 8px 0 0; }
li { margin: 4px 0; }
.warn { color: var(--beacon-deep); font-size: 13px; line-height: 18px; margin-top: 24px; }
@media (max-width: 640px) { main { margin: 0; padding: 20px 16px; border: 0; } .grid { grid-template-columns: 1fr; } }
@media print {
  body { background: #fff; }
  main { margin: 0; padding: 0; border: 0; max-width: none; background: #fff; }
  .screen { display: none; }
  .row, .grid { break-inside: avoid; }
}
</style></head>
<body><main>
<h1>Vyre recovery kit</h1>
<p class="sub">For ${esc(k.name)} · made ${esc(new Date(k.created).toISOString().slice(0, 10))}. Print it, write your password on it by hand, and keep it somewhere safe.</p>
<div class="grid"><div>
${row("Account ID", esc(k.acct || "not set yet"))}
${row("Secret Key", esc(k.sk), "key")}
${row("Fingerprint", esc(k.fp))}
${row("Box address", esc(k.relay || "none (this Vyre has no relay address)"))}
${row("Password", '<div class="blank"></div>')}
</div><div class="qr">${qr}<p>Scan with a new device's Vyre to fill in the account, Secret Key and box. It does not hold your password.</p></div></div>
<div class="row"><div class="label">Setting up a new device</div><ol>
<li>Install Vyre on the new device and start it.</li>
<li>Choose to restore an account, then scan this code or type the Account ID and Secret Key.</li>
<li>Type your password. Compare the fingerprint above with the one the new device shows.</li>
<li>Once it opens, keep this sheet: it is the way back if every device is lost.</li>
</ol></div>
<p class="warn">Anyone with this sheet and your password can open your vault. Keep them apart. This page was shown once and will not load again.</p>
<p class="screen warn">Print now (Command-P or Control-P). Closing this tab loses it.</p>
</main></body></html>`;
}

/**
 * Serve one kit, once. Resolves when listening, with the one-time URL and when it expires.
 * @param {{ secretKey: () => Promise<string|null|undefined> | string | null | undefined,
 *   info: () => Promise<{ name: string, acct?: string, fp: string, relay?: string|null }>,
 *   ttlMs?: number, onServed?: () => void, onClosed?: (why: "served"|"expired"|"closed") => void }} o
 * @returns {Promise<{ url: string, expires: number, close: () => Promise<void>, closed: Promise<string> }>}
 */
export async function serveKit({ secretKey, info, ttlMs = TTL_MS, onServed = () => {}, onClosed = () => {} }) {
  const token = crypto.randomBytes(24).toString("base64url");
  let used = false, port = 0, why = /** @type {"served"|"expired"|"closed"} */ ("closed");
  /** @type {(w: string) => void} */
  let resolveClosed = () => {};
  const closed = new Promise(r => { resolveClosed = r; });
  const headers = {
    "cache-control": "no-store, max-age=0", pragma: "no-cache", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
  };
  const server = http.createServer(async (req, res) => {
    const host = String(req.headers.host || "");
    const pathOk = req.method === "GET" && new URL(req.url || "/", "http://kit").pathname === `/kit/${token}`;
    if (!pathOk || host !== `127.0.0.1:${port}` || used) {
      res.writeHead(404, { ...headers, "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    used = true;
    why = "served";
    try {
      const sk = await secretKey();
      if (!sk) throw new Error("no secret key");
      const page = kitPage({ ...(await info()), sk: String(sk), created: Date.now() });
      res.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8" });
      res.end(page);
      onServed();
    } catch {
      res.writeHead(500, { ...headers, "content-type": "text/plain" });
      res.end("the kit could not be made; run vyre vault kit again");
    } finally { shut(); }
  });
  let done = false;
  const shut = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    server.close(() => { onClosed(why); resolveClosed(why); });
    server.closeIdleConnections();
  };
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(undefined)); });
  port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
  const expires = Date.now() + ttlMs;
  const timer = setTimeout(() => { if (!used) why = "expired"; shut(); }, ttlMs);
  timer.unref();
  return {
    url: `http://127.0.0.1:${port}/kit/${token}`,
    expires,
    close: async () => { shut(); await closed; },
    closed: /** @type {Promise<string>} */ (closed),
  };
}
