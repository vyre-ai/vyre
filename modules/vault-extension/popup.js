// @ts-check
// popup: settings, unlock, the list of logins for this page, the vault's cards and addresses,
// and the two page toggles (suggestions, passkeys). It never holds a password or a card number:
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
  const inl = await ask({ type: "inline-state" });
  input("inline").checked = Boolean(inl.data && inl.data.inline);
  const pk = await ask({ type: "passkeys-state" });
  input("passkeys").checked = Boolean(pk.data && pk.data.passkeys);
  input("passkeys").disabled = Boolean(pk.data && !pk.data.supported);
  if (pk.data && !pk.data.supported) $("passkeys-row").title = "Passkeys need Firefox 128 or later.";
  await listLogins();
  await listCards();
}

/** Cards and addresses: the same on every page, each with a Fill for the active tab. */
async function listCards() {
  const list = $("cards");
  list.replaceChildren();
  const r = await ask({ type: "cards" });
  if (r.error) { $("cards-box").hidden = true; return; }
  const rows = [...r.data.cards.map(c => ({ ...c, kind: "card" })), ...r.data.addresses.map(a => ({ ...a, kind: "address" }))];
  $("cards-box").hidden = rows.length === 0;
  for (const c of rows) {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = c.description || c.name;
    const d = document.createElement("small");
    d.textContent = c.kind === "card" ? `Card · ${c.name}` : `Address · ${c.name}`;
    label.append(d);
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = "Fill";
    b.addEventListener("click", async () => {
      b.disabled = true;
      const f = await ask({ type: c.kind === "card" ? "card-fill" : "address-fill", name: c.name });
      b.disabled = false;
      if (f.error) {
        // A card that asks every time needs a fresh proof: the unlock box, then Fill again.
        if (f.error.code === "reprompt") { show("unlock"); input("passphrase").focus(); return say(f.error.message, true); }
        say(f.error.message, true);
        if (/session/.test(f.error.code)) await refresh();
        return;
      }
      if (!f.data.filled.length) return say(f.data.why || "nothing to fill here", true);
      window.close();
    });
    li.append(label, b);
    list.append(li);
  }
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

// Suggestions on pages need the browser's leave to run on every site, asked for on this click.
input("inline").addEventListener("change", async () => {
  const box = input("inline");
  say("");
  if (box.checked) {
    const granted = await chrome.permissions.request({ origins: ["https://*/*", "http://*/*"] });
    const r = granted ? await ask({ type: "inline-enable" }) : { error: { message: "The browser did not allow suggestions on pages." } };
    if (r.error) { box.checked = false; return say(r.error.message, true); }
    say("Suggestions are on. Reload open pages to see them.");
  } else {
    await ask({ type: "inline-disable" });
    // Passkeys share the page permission; it goes only when both are off.
    if (!input("passkeys").checked) await chrome.permissions.remove({ origins: ["https://*/*", "http://*/*"] });
    say("Suggestions are off.");
  }
});

// Passkeys run on every page too (the page's own world and a prompt beside it), so they need
// the same leave, asked for on this click. On by default: once page access is granted for
// either toggle, passkeys come on unless turned off here.
input("passkeys").addEventListener("change", async () => {
  const box = input("passkeys");
  say("");
  if (box.checked) {
    const granted = await chrome.permissions.request({ origins: ["https://*/*", "http://*/*"] });
    const r = granted ? await ask({ type: "passkeys-enable" }) : { error: { message: "The browser did not allow passkeys on pages." } };
    if (r.error) { box.checked = false; return say(r.error.message, true); }
    say("Vyre answers passkey requests now. Reload open pages to use it.");
  } else {
    await ask({ type: "passkeys-disable" });
    if (!input("inline").checked) await chrome.permissions.remove({ origins: ["https://*/*", "http://*/*"] });
    say("Passkeys are the browser's own again.");
  }
});

$("settings").addEventListener("click", () => { show("setup"); say(""); });

$("forget").addEventListener("click", async () => {
  await ask({ type: "forget" });
  say("This browser is unpaired here. Run vyre vault devices to revoke it on the vault too.");
  await refresh();
});

refresh();
