// A bundled local page: the only kind of content that may call the shell's commands.
const invoke = window.__TAURI_INTERNALS__.invoke;
const addr = document.getElementById("addr");
const err = document.getElementById("err");
async function go() {
  err.textContent = "";
  const raw = addr.value.trim();
  const address = raw.startsWith("https://") ? raw : "https://" + raw;
  try { await invoke("save_pairing", { address }); }
  catch (e) { err.textContent = String(e); }
}
// The typed code is on in every build unless the shell was built with VYRE_TYPED_CODE=0 (get_state.typed_code false): then the page hides it.
invoke("get_state").then((s) => { if (s && s.typed_code === false) document.getElementById("typed").hidden = true; }).catch(() => {});
document.getElementById("go").addEventListener("click", go);
addr.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
