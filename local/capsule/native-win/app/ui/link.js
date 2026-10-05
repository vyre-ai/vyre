// The hidden, always-running bundled page that holds the Noise channel to the paired box and makes
// box calls for the shell. Only this window and first-run have the device key commands;
// the remote main panel has none. The box's answer goes straight to a shell command from here.
import { shellDeviceKey } from "./relay/shellkey.js";
import { connect } from "./relay/client.js";

const internals = window.__TAURI_INTERNALS__;
const invoke = internals.invoke;
const say = (title, body) => invoke("notify", { title, body }).catch(() => {});

// This window is never visible, so the client must not wait for "visible" to dial.
const visibility = { hidden: () => false, on: () => () => {} };

let conn = null;
async function link() {
  if (conn) return conn;
  const l = await invoke("get_link");
  if (!l) throw new Error("This computer is not paired yet.");
  conn = connect({ relay: l.relay, route: l.route, box: l.box, name: "this computer", about: { kind: "app" }, visibility, ...shellDeviceKey(invoke) });
  return conn;
}

async function call(tool, input = {}) {
  const c = await link();
  const res = await c.fetch(`/v1/tools/${tool}`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify(input),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body.error && body.error.message) || `the box answered ${res.status}`);
  return body.data;
}

link().catch(() => {});
