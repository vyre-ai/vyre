// @ts-check
// popup: settings, unlock and the list of logins for this page. It never holds a password:
// it asks the background worker to fill a login by name, and the worker hands the value
// straight to the page. The passphrase typed here goes to the worker once and is not kept.

/* global chrome */

/** @param {string} id */
const $ = id => /** @type {HTMLElement} */ (document.getElementById(id));
const input = id => /** @type {HTMLInputElement} */ ($(id));

/** @param {any} msg @returns {Promise<any>} */
const ask = msg => chrome.runtime.sendMessage(msg);

function say(text, bad = false) {
  $("msg").textContent = text || "";
  $("msg").classList.toggle("bad", bad);
}

function show(which) {
  for (const id of ["setup", "unlock", "logins"]) $(id).hidden = id !== which;
}

/** Ask for the host permission of an address that is not the default 127.0.0.1. Needs this click. */
async function permit(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.hostname === "127.0.0.1") return true;
  return chrome.permissions.request({ origins: [`${u.protocol}//${u.hostname}/*`] });
}

async function refresh() {
  const r = await ask({ type: "state" });
  if (r.error) return say(r.error.message, true);
  const s = r.data;
  $("where").textContent = s.origin ? new URL(s.origin).host : "";
  input("url").value = s.url;
  $("forget").hidden = !s.paired;
  if (!s.paired) { show("setup"); if (s.problem) say(s.problem, true); return; }
  if (!s.unlocked) {
    show("unlock");
    if (s.canUnlock === false) say("Set an unlock passphrase first: vyre vault unlock-passphrase", true);
    else if (s.problem) say(s.problem, true);
    input("passphrase").focus();
    return;
  }
  show("logins");
  await listLogins();
}

async function listLogins() {
  const list = $("list");
  list.replaceChildren();
  const r = await ask({ type: "match" });
  if (r.error) return say(r.error.message, true);
  $("empty").hidden = r.data.logins.length > 0;
  for (const l of r.data.logins) {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = l.name;
    if (l.description) { const d = document.createElement("small"); d.textContent = l.description; label.append(d); }
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = "Fill";
    b.addEventListener("click", async () => {
      b.disabled = true;
      const f = await ask({ type: "fill", name: l.name });
      b.disabled = false;
      if (f.error) { say(f.error.message, true); if (/session/.test(f.error.code)) await refresh(); return; }
      if (!f.data.filled.length) return say(f.data.why || "nothing to fill here", true);
      window.close();
    });
    li.append(label, b);
    list.append(li);
  }
}

$("pair").addEventListener("click", async () => {
  say("");
  const url = input("url").value.trim() || input("url").placeholder;
  if (!(await permit(url))) return say("The browser did not allow that address.", true);
  const saved = await ask({ type: "save-url", url });
  if (saved.error) return say(saved.error.message, true);
  const r = await ask({ type: "pair", code: input("code").value, name: input("name").value.trim() || "browser" });
  input("code").value = "";
  if (r.error) return say(r.error.message, true);
  say(`Paired as ${r.data.name}.`);
  await refresh();
});

$("unlock-btn").addEventListener("click", async () => {
  say("");
  const p = input("passphrase");
  const r = await ask({ type: "unlock", passphrase: p.value });
  p.value = "";
  if (r.error) return say(r.error.message, true);
  await refresh();
});
input("passphrase").addEventListener("keydown", e => { if (e.key === "Enter") $("unlock-btn").click(); });

$("lock").addEventListener("click", async () => { await ask({ type: "lock" }); say("Locked."); await refresh(); });

$("settings").addEventListener("click", () => { show("setup"); say(""); });

$("forget").addEventListener("click", async () => {
  await ask({ type: "forget" });
  say("This browser is unpaired here. Run vyre vault devices to revoke it on the vault too.");
  await refresh();
});

refresh();
