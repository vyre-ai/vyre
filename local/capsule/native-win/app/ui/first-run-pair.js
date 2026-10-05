import { startTypedPairing } from "./typed-pair.js";
import { joinWithCode } from "./relay/join.js";
import { shellDeviceKey } from "./relay/shellkey.js";

const invoke = window.__TAURI_INTERNALS__.invoke;
const code = document.getElementById("code"), ack = document.getElementById("ack"), err = document.getElementById("err"), go = document.getElementById("typed-go");
let busy = false;

async function pair() {
  if (busy || !code.value.trim()) return;
  busy = true; go.disabled = true; err.textContent = ""; ack.textContent = "";
  const r = await startTypedPairing({
    input: code.value,
    onAck: (a) => { ack.textContent = "Type this on your other device: " + a; },
  }, { joinWithCode, shellDeviceKey, invoke, relay: "wss://relay.vyre.run" });
  busy = false; go.disabled = false;
  if (!r.ok) { ack.textContent = ""; err.textContent = r.say; }
}
go.addEventListener("click", pair);
code.addEventListener("keydown", (e) => { if (e.key === "Enter") pair(); });
