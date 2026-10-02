// The hidden, always-running bundled page that holds the Noise channel to the paired box and makes
// box calls for the shell (Drive). Only this window and first-run have the device key commands;
// the remote main panel has none. The box's answer goes straight to a shell command from here.
import { shellDeviceKey } from "./relay/shellkey.js";
import { connect } from "./relay/client.js";
import { personSession } from "./person.js";

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

// The local helper asks the app to vouch for it (core_host.rs): the app built the call and its presence proof; this page, which holds the
// channel to the server, makes the call as a person on this device and hands the server's answer back. The page adds nothing to the call.
const person = personSession({
  send: async (path, init) => { const c = await link(); return c.fetch(path, init); },
  presenceProof: (key) => invoke("person_start_proof", { key }),
});

async function vouch(input, proof) {
  const path = "/v1/tools/link.companion.pair";
  const body = JSON.stringify(input);
  const c = await link();
  for (let attempt = 0; ; attempt++) {
    const res = await c.fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-vyre-presence": proof, ...(await person.headers("POST", path, body)) }, body });
    const b = await res.json().catch(() => ({}));
    if (res.status === 401 && b.error && b.error.code === "person_session_required" && attempt === 0) { person.forget(); continue; }
    return b;
  }
}

internals.invoke("plugin:event|listen", {
  event: "vyre-companion",
  target: { kind: "Window", label: "link" },
  handler: internals.transformCallback((e) => {
    const { id, input, proof } = e.payload;
    vouch(input, proof)
      .then((answer) => invoke("companion_result", { id, answer }))
      .catch((err) => invoke("companion_result", { id, answer: { error: { message: String((err && err.message) || err) } } }));
  }),
}).catch(() => {});

/** Map the first shared Vyre Drive folder as a network drive and open it. */
async function mountDrive() {
  try {
    const c = await call("files.drive.candidates", {});
    const shared = ((c && c.items) || c || []).find?.((x) => x.shared);
    if (!shared) return say("Vyre Drive", "No folder is shared yet. Choose one in Settings, then Drive.");
    const a = await call("files.drive.address", { share: shared.share || shared.name || shared.suggestedName });
    if (!a || !a.unc) return say("Vyre Drive", "The server has no address for that folder yet.");
    // Name the folder before it opens: the box supplied the path, so the person sees what is mapped.
    await say("Vyre Drive", "Opening " + a.unc.split("\\").slice(3).join("\\") + " from " + (shared.share || shared.name || shared.suggestedName) + ".");
    await invoke("mount_drive", { unc: a.unc });
  } catch (e) {
    say("Vyre Drive", String((e && e.message) || e));
  }
}

// The tray's "Open Vyre Drive" arrives as an event from the shell, the same call the Tauri
// JS API makes for `listen`.
internals.invoke("plugin:event|listen", {
  event: "vyre-drive",
  target: { kind: "Window", label: "link" },
  handler: internals.transformCallback(() => { mountDrive(); }),
}).catch(() => {});

link().catch(() => {});
