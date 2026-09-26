// e2e CDP driver: holds one session on the stand-in Mac's headless Chrome, so a virtual
// authenticator lives as long as the run. Control over HTTP on the test box's loopback only.
//   POST /nav {url}   /eval {expr}   /shot {file}   /webauthn   /creds   /log
import http from "node:http";
import fs from "node:fs";

const CDPPORT = process.env.CDP_PORT || "19222", CTL = Number(process.env.CTL_PORT || 19300);
const CDP = "http://127.0.0.1:" + CDPPORT;
const fix = u => u.replace("ws://127.0.0.1:9222", "ws://127.0.0.1:" + CDPPORT);
const version = await (await fetch(CDP + "/json/version")).json();
const ws = new WebSocket(fix(version.webSocketDebuggerUrl));
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const wait = new Map(); const logs = [];
ws.onmessage = m => {
  const d = JSON.parse(m.data);
  if (d.id && wait.has(d.id)) { const w = wait.get(d.id); wait.delete(d.id); d.error ? w.j(new Error(JSON.stringify(d.error))) : w.r(d.result); }
  else if (d.method === "Runtime.consoleAPICalled") logs.push(`console.${d.params.type}: ` + d.params.args.map(a => a.value ?? a.description).join(" "));
  else if (d.method === "Runtime.exceptionThrown") logs.push("exception: " + (d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text));
  else if (d.method === "Log.entryAdded") logs.push(`log.${d.params.entry.level}: ${d.params.entry.text} ${d.params.entry.url || ""}`);
  else if (d.method === "WebAuthn.credentialAdded") logs.push("webauthn: credential added " + d.params.credential.rpId);
  else if (d.method === "WebAuthn.credentialAsserted") logs.push("webauthn: credential asserted " + d.params.credential.rpId);
};
const send = (method, params = {}, sessionId) => new Promise((r, j) => { const i = ++id; wait.set(i, { r, j }); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });

const { targetInfos } = await send("Target.getTargets");
let page = targetInfos.find(t => t.type === "page");
if (!page) page = { targetId: (await send("Target.createTarget", { url: "about:blank" })).targetId };
const { sessionId } = await send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
const s = (m, p) => send(m, p, sessionId);
await s("Page.enable"); await s("Runtime.enable"); await s("Log.enable");
await s("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
let authenticatorId = null;

const ev = async expr => {
  const r = await s("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

const routes = {
  "/nav": async ({ url }) => { await s("Page.navigate", { url }); await new Promise(r => setTimeout(r, 2500)); return await ev("location.href + ' | ' + document.title"); },
  "/eval": async ({ expr }) => ev(expr),
  "/shot": async ({ file, full }) => { const r = await s("Page.captureScreenshot", { format: "png", captureBeyondViewport: !!full }); fs.writeFileSync(file, Buffer.from(r.data, "base64")); return file; },
  "/webauthn": async () => {
    await s("WebAuthn.enable", { enableUI: false });
    authenticatorId = (await s("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal",
      hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } })).authenticatorId;
    return authenticatorId;
  },
  "/creds": async () => authenticatorId ? (await s("WebAuthn.getCredentials", { authenticatorId })).credentials.map(c => ({ rpId: c.rpId, resident: c.isResidentCredential, signCount: c.signCount, userHandle: c.userHandle })) : [],
  "/log": async () => logs.splice(0),
  // Export and import a credential: a passkey synced between the owner's devices (iCloud Keychain does this).
  "/export": async () => authenticatorId ? (await s("WebAuthn.getCredentials", { authenticatorId })).credentials : [],
  "/import": async ({ credentials }) => { for (const c of credentials) await s("WebAuthn.addCredential", { authenticatorId, credential: c }); return credentials.length; },
};

http.createServer((req, res) => {
  let b = ""; req.on("data", c => b += c); req.on("end", async () => {
    try { const out = await routes[req.url](b ? JSON.parse(b) : {}); res.end(JSON.stringify({ ok: out }, null, 1) + "\n"); }
    catch (e) { res.end(JSON.stringify({ error: e.message }) + "\n"); }
  });
}).listen(CTL, "127.0.0.1", () => console.log("driver on 127.0.0.1:" + CTL));
