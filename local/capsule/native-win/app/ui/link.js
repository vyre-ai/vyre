// The hidden, always-running bundled page that holds the Noise channel to the paired box. Only this window and first-run have the device key commands;
// the remote main panel has none.
import { shellDeviceKey } from "./relay/shellkey.js";
import { connect } from "./relay/client.js";

const internals = window.__TAURI_INTERNALS__;
const invoke = internals.invoke;

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

link().catch(() => {});
