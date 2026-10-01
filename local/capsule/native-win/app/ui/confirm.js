// Shows who the pairing ticket names, and pairs only when the person says yes.
const invoke = window.__TAURI_INTERNALS__.invoke;
const $ = (id) => document.getElementById(id);
invoke("pending_pair").then((p) => {
  if (!p) { $("detail").textContent = "Nothing to pair."; $("yes").hidden = true; return; }
  $("title").textContent = "Pair this computer?";
  // The name is whatever the server calls itself; the address and fingerprint are what identify it.
  const lines = ["Address: " + p.host, "Name it gives itself: " + p.name, "Key fingerprint: " + p.fingerprint];
  if (p.own_domain) lines.push("This address is not on vyre.run. Pair only if it is your own domain.");
  else lines.push("Pair only if this is your own server.");
  $("detail").textContent = lines.join("\n");
});
$("yes").addEventListener("click", () => invoke("confirm_pair").catch((e) => { $("err").textContent = String(e); }));
$("no").addEventListener("click", () => invoke("cancel_pair"));
