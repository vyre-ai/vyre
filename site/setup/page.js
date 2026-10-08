// The reserve page: pick a name, get a code, paste it into the Vyre app. No key is made here, nothing is stored, and the code is shown once in this tab.
import { DIRECTORY, MESSAGES, checkAnswer, lasts, looksLikeName, nameOf, reserveAnswer } from "./reserve.js";

const $ = id => /** @type {HTMLElement} */ (document.getElementById(id));
const input = /** @type {HTMLInputElement} */ ($("name"));
const hint = $("hint"), go = /** @type {HTMLButtonElement} */ ($("reserve"));
let timer = 0, asked = "", free = false;

async function json(url, init) {
  const r = await fetch(url, { ...init, headers: { accept: "application/json", ...(init && init.headers) }, cache: "no-store" });
  let body = null;
  try { body = await r.json(); } catch { /* not JSON */ }
  return { status: r.status, body };
}

function check() {
  const name = nameOf(input.value);
  free = false; go.disabled = true;
  clearTimeout(timer);
  if (!name) { hint.textContent = ""; return; }
  if (!looksLikeName(name)) { hint.textContent = MESSAGES.invalid; return; }
  hint.textContent = "Checking";
  timer = setTimeout(async () => {
    asked = name;
    let answer = "unknown";
    try { const r = await json(`${DIRECTORY}/v1/names/check?name=${encodeURIComponent(name)}`); answer = checkAnswer(r.status, r.body); } catch { /* offline */ }
    if (asked !== name) return;
    hint.textContent = answer === "free" ? `${name}.vyre.run is free.` : MESSAGES[answer];
    free = answer === "free"; go.disabled = !free;
  }, 350);
}

input.addEventListener("input", check);
$("form").addEventListener("submit", async e => {
  e.preventDefault();
  const name = nameOf(input.value);
  if (!free || !name) return;
  go.disabled = true; hint.textContent = "Reserving";
  let out;
  try {
    const r = await json(`${DIRECTORY}/v1/ids/reserve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
    out = reserveAnswer(r.status, r.body);
  } catch { out = { ok: false, say: "Vyre could not reach the directory. Check your connection and try again." }; }
  if (!out.ok) { hint.textContent = out.say; go.disabled = false; return; }
  $("pick").hidden = true; $("done").hidden = false;
  $("address").textContent = `${name}.vyre.run`;
  $("code").textContent = out.code;
  $("lasts").textContent = lasts(out.expires, Date.now());
  $("done-title").focus();
});
$("copy").addEventListener("click", async e => {
  const b = /** @type {HTMLButtonElement} */ (e.currentTarget);
  try { await navigator.clipboard.writeText($("code").textContent || ""); b.textContent = "Copied"; } catch { b.textContent = "Select the code and copy it"; }
  setTimeout(() => { b.textContent = "Copy"; }, 2500);
});
