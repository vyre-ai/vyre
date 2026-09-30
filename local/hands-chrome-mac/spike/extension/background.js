// Spike service worker. Why: prove, with a real Chrome, that an MV3 worker can (1) connectNative
// to a host registered for the user-data-dir, (2) attach chrome.debugger to a tab and run
// Runtime.evaluate, (3) answer framed {id, op, args} requests from the host with low latency.
// It is NOT the real extension (local/hands-chrome-mac/extension); the harness can swap that in.
//
// Ops: ping | tabs | attach | detach | eval. Every answer is {id, ok, result} or {id, ok:false, error}.
// State for diagnostics lives on globalThis.__spike (the harness reads it over CDP with --diag).

const HOST = "run.vyre.chrome";
const spike = (globalThis.__spike = { events: [], connects: 0, attached: [] });
const log = m => { spike.events.push({ t: Date.now(), m: String(m) }); if (spike.events.length > 200) spike.events.shift(); };

/** @type {chrome.runtime.Port | null} */
let port = null;
let tries = 0;
const attached = new Set();

function send(msg) { if (port) port.postMessage(msg); }

function retry() {
  if (++tries <= 30) setTimeout(connect, 1000);
  else log("gave up connecting");
}

function connect() {
  try {
    port = chrome.runtime.connectNative(HOST);
    spike.connects++;
  } catch (e) { log("connectNative threw: " + e.message); port = null; retry(); return; }
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    log("disconnect: " + (err && err.message));
    port = null;
    retry();
  });
  send({ event: "hello", ua: navigator.userAgent, t: Date.now(), connects: spike.connects });
}

async function findTab(prefix) {
  const tabs = await chrome.tabs.query({});
  const t = tabs.find(x => x.url && x.url.startsWith(prefix || "http://127.0.0.1"));
  if (!t) throw new Error("no tab for " + prefix);
  return t;
}

async function attach(tabId) {
  const t0 = performance.now();
  await chrome.debugger.attach({ tabId }, "1.3");
  const t1 = performance.now();
  await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
  const t2 = performance.now();
  attached.add(tabId);
  spike.attached = [...attached];
  return { tabId, attachMs: t1 - t0, attachPlusEnableMs: t2 - t0 };
}

chrome.debugger.onDetach.addListener((source, reason) => { attached.delete(source.tabId); log("detached " + source.tabId + " " + reason); });

const ops = {
  async ping() { return { pong: true, t: Date.now() }; },
  async tabs() { return (await chrome.tabs.query({})).map(t => ({ id: t.id, url: t.url || "", title: t.title || "" })); },
  async attach(args) {
    const tab = await findTab(args.urlPrefix);
    if (attached.has(tab.id)) return { tabId: tab.id, already: true };
    return attach(tab.id);
  },
  async detach(args) {
    const tab = await findTab(args.urlPrefix);
    await chrome.debugger.detach({ tabId: tab.id });
    attached.delete(tab.id);
    return { tabId: tab.id };
  },
  async eval(args) {
    const tab = await findTab(args.urlPrefix);
    if (!attached.has(tab.id)) await attach(tab.id);
    const r = await chrome.debugger.sendCommand({ tabId: tab.id }, "Runtime.evaluate", { expression: args.expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || "evaluate failed");
    return r.result.value;
  },
};

async function onMessage(msg) {
  if (!msg || msg.id === undefined) return;
  const fn = ops[msg.op];
  if (!fn) { send({ id: msg.id, ok: false, error: { code: "unknown_op", message: String(msg.op) } }); return; }
  try { send({ id: msg.id, ok: true, result: await fn(msg.args || {}) }); }
  catch (e) { send({ id: msg.id, ok: false, error: { code: "op_failed", message: String(e && e.message || e) } }); }
}

connect();
