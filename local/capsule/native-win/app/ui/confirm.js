// Shows who the pairing ticket names, and pairs only when the person says yes.
const invoke = window.__TAURI_INTERNALS__.invoke;
const $ = (id) => document.getElementById(id);
invoke("pending_pair").then((p) => {
  if (!p) { $("detail").textContent = "Nothing to pair."; $("yes").hidden = true; return; }
  $("title").textContent = "Pair with " + p.name + "?";
  $("detail").textContent = "Its key fingerprint is " + p.fingerprint + ". Pair only if this is your own server.";
});
$("yes").addEventListener("click", () => invoke("confirm_pair").catch((e) => { $("err").textContent = String(e); }));
$("no").addEventListener("click", () => invoke("cancel_pair"));
