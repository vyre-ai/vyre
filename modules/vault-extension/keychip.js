// @ts-check
// keychip: the content script behind "Save this key to Vyre". It runs in the page's top frame,
// registered beside keyfind.js (loaded first) once the browser is paired and allowed on pages.
//
// Why it is built this way:
//   - Detection is local. It looks at text a page already shows (a code or input element, the
//     text a person selects to copy, the box next to a Copy button they click) and asks keyfind.js
//     whether one value looks like a key. Nothing about the page, its text or the other values
//     leaves it. The value itself stays in this script until the person taps Save.
//   - Before the chip appears the worker is told only a fingerprint and whether the shape was
//     generic. The worker records the page origin the chip was raised on and answers whether that
//     fingerprint was already offered in this tab; a value is never offered twice.
//   - Password inputs are skipped: a password typed or shown there is login save's (inline.js).
//   - One tap on Save stores the key ready to use; there is no review step. The same chip then
//     shows Undo for ten seconds. A tap counts only when its event isTrusted.
//   - The chip is drawn in a closed shadow root, so the page cannot read it or restyle its button,
//     and it never shows the key.

/* global chrome */

(() => {
  const g = /** @type {any} */ (globalThis);
  if (g.vyreKeyChip || window.top !== window || !g.vyreKeyFind) return;
  g.vyreKeyChip = true;
  const K = g.vyreKeyFind;

  const UNDO_MS = 10_000;
  const MAX_SCAN = 1500;
  const SELECTOR = 'code, pre, samp, kbd, input, textarea, span, div, p, td, dd, li, strong, b, [data-clipboard-text], [data-copy]';
  const COPY_WORD = /\b(copy|copied|clipboard)\b/i;

  /** @param {any} msg @returns {Promise<any>} */
  const ask = msg => new Promise(resolve => {
    try { chrome.runtime.sendMessage(msg, r => resolve(chrome.runtime.lastError ? { error: { code: "gone", message: "the extension restarted" } } : r)); }
    catch { resolve({ error: { code: "gone", message: "the extension restarted" } }); }
  });

  // ---- the chip -------------------------------------------------------------------------

  const host = document.createElement("vyre-vault-key");
  host.style.cssText = "all: initial; position: fixed; z-index: 2147483647; right: 16px; bottom: 16px;";
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    .chip { font: 13px/1.4 system-ui, sans-serif; background: #fff; color: #16181d; border: 1px solid #d5d8de;
      border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.18); padding: 8px 10px; max-width: 340px; }
    @media (prefers-color-scheme: dark) { .chip { background: #1d2027; color: #eceef2; border-color: #333844; } }
    .t { font-weight: 600; margin-bottom: 6px; } .m { opacity: .75; font-size: 12px; margin-bottom: 6px; }
    .row { display: flex; gap: 6px; }
    button { all: unset; box-sizing: border-box; padding: 5px 12px; border-radius: 6px; cursor: pointer; text-align: center;
      background: rgba(43, 89, 195, .16); }
    button:hover, button:focus-visible { background: rgba(43, 89, 195, .3); }
    button.quiet { background: transparent; opacity: .75; }`;
  root.append(style);
  const chip = document.createElement("div");
  chip.className = "chip";
  root.append(chip);

  /** @type {ReturnType<typeof setTimeout>|null} */
  let timer = null;
  /** True while a chip is up, so a second candidate waits instead of replacing it. */
  let showing = false;
  /** @type {Array<() => void>} */
  const waiting = [];

  function hide() {
    if (timer) clearTimeout(timer);
    timer = null;
    host.remove();
    chip.replaceChildren();
    showing = false;
    const next = waiting.shift();
    if (next) next();
  }

  /** @param {string} text @param {string} [cls] */
  function line(text, cls = "m") {
    const d = document.createElement("div");
    d.className = cls;
    d.textContent = text;
    return d;
  }

  /** A button that acts only on a trusted click. @param {string} text @param {() => void} act @param {string} [cls] */
  function button(text, act, cls = "") {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    if (cls) b.className = cls;
    b.addEventListener("click", e => {
      if (!e.isTrusted) return;
      e.preventDefault();
      e.stopPropagation();
      act();
    });
    return b;
  }

  const PROVIDER_NAMES = /** @type {Record<string, string>} */ ({ anthropic: "Anthropic", openai: "OpenAI", openrouter: "OpenRouter", stripe: "Stripe",
    github: "GitHub", gitlab: "GitLab", slack: "Slack", aws: "AWS", google: "Google", sendgrid: "SendGrid", resend: "Resend", mailgun: "Mailgun",
    twilio: "Twilio", npm: "npm", pypi: "PyPI", huggingface: "Hugging Face", digitalocean: "DigitalOcean", perplexity: "Perplexity",
    linear: "Linear", sentry: "Sentry", pinecone: "Pinecone", jina: "Jina", apify: "Apify", supabase: "Supabase" });

  /** @param {{ value: string, provider: string|null, label: string|null }} c @param {string} fp */
  function raise(c, fp) {
    showing = true;
    const who = c.provider ? `${PROVIDER_NAMES[c.provider] || c.provider} ` : "";
    chip.replaceChildren(line(`Save this ${who}key to Vyre?`, "t"));
    const row = document.createElement("div");
    row.className = "row";
    row.append(
      button("Save", async () => {
        const value = c.value;
        const r = await ask({ type: "key-save", fp, value, label: c.label || "", generic: !c.provider });
        chip.replaceChildren();
        if (!r || r.error || !r.data) { chip.append(line(r && r.error ? r.error.message : "Could not save this key."), button("Close", hide, "quiet")); return; }
        const d = r.data;
        chip.append(line(d.created === false ? `Already saved as ${d.name}.` : `Saved as ${d.name}${d.connected ? `, ready for ${d.connected}` : ""}.`, "t"));
        if (d.created === false) { timer = setTimeout(hide, 3000); return; }
        const undo = button("Undo", async () => {
          if (timer) clearTimeout(timer);
          const u = await ask({ type: "key-undo", name: d.name });
          chip.replaceChildren(line(u && u.error ? u.error.message : "Removed.", "t"));
          timer = setTimeout(hide, 2000);
        });
        chip.append(undo);
        timer = setTimeout(hide, UNDO_MS);
      }),
      button("Not now", () => { ask({ type: "key-dismiss", fp }); hide(); }, "quiet"),
    );
    chip.append(row);
    document.documentElement.append(host);
  }

  /** One candidate at most once: this page load's set here, the tab's set in the worker. @type {Set<string>} */
  const seen = new Set();

  /** @param {{ value: string, provider: string|null, generic: boolean, label: string|null }} c */
  async function offer(c) {
    const fp = K.fingerprint(c.value);
    if (seen.has(fp)) return;
    seen.add(fp);
    const r = await ask({ type: "key-raise", fp, generic: c.generic });
    if (!r || !r.data || !r.data.raise) return;
    const go = () => raise(c, fp);
    if (showing) waiting.push(go); else go();
  }

  // ---- reading a page's elements --------------------------------------------------------

  /** @param {Element} el */
  const visible = el => el.getClientRects().length > 0;

  /** The words around an element that say what it is: its own labels, then its nearest neighbours. @param {Element} el */
  function around(el) {
    const bits = [el.getAttribute("aria-label"), el.getAttribute("placeholder"), el.getAttribute("name"), el.getAttribute("id"), el.getAttribute("title"), el.getAttribute("data-testid")];
    const labels = /** @type {any} */ (el).labels;
    if (labels) for (const l of labels) bits.push(l.textContent);
    const prev = el.previousElementSibling;
    if (prev) bits.push(prev.textContent);
    let p = el.parentElement;
    for (let i = 0; p && i < 3; i++, p = p.parentElement) {
      bits.push((p.getAttribute("aria-label") || "") + " " + (p.firstElementChild && p.firstElementChild !== el ? p.firstElementChild.textContent : ""));
    }
    return bits.filter(Boolean).join(" ").slice(0, 400);
  }

  /** The candidate one element holds, if any. @param {Element} el */
  function fromElement(el) {
    let value = "";
    let kind = "";
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      kind = /** @type {any} */ (el).type === "password" ? "password" : "";
      value = el.value;
    } else if (el.children.length === 0) {
      value = el.getAttribute("data-clipboard-text") || el.getAttribute("data-copy") || el.textContent || "";
    } else {
      return null;
    }
    value = value.trim();
    if (value.length < 16 || value.length > K.MAX || /\s/.test(value)) return null;
    if (!visible(el)) return null;
    return K.candidate({ value, label: around(el), kind });
  }

  /** Every candidate in a scope, bounded. @param {ParentNode} scope */
  function scan(scope) {
    /** @type {any[]} */
    const out = [];
    let n = 0;
    for (const el of scope.querySelectorAll(SELECTOR)) {
      if (++n > MAX_SCAN) break;
      const c = fromElement(el);
      if (c) out.push(c);
    }
    return out;
  }

  /** A page holding a password field with the same value is a login form: never a key. */
  function passwordValues() {
    return new Set([...document.querySelectorAll('input[type="password"]')].map(p => /** @type {HTMLInputElement} */ (p).value).filter(Boolean));
  }

  function scanPage() {
    const pw = passwordValues();
    for (const c of scan(document)) if (!pw.has(c.value)) offer(c);
  }

  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; try { scanPage(); } catch { /* a page that will not be read */ } }, 400);
  }

  // A key shown once often arrives after a click or a fetch: watch for new text, cheaply.
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  schedule();

  // Copy: the text a person selects and copies, if it is a key. Selection is read only here, and
  // only the matched value is used.
  document.addEventListener("copy", e => {
    if (!e.isTrusted) return;
    try {
      const sel = String(getSelection() || "").trim();
      if (sel.length < 16 || sel.length > K.MAX) return;
      const node = getSelection() && getSelection().anchorNode;
      const el = node && (node.nodeType === 1 ? /** @type {Element} */ (node) : node.parentElement);
      const c = K.candidate({ value: sel, label: el ? around(el) : "" });
      if (c) offer(c);
    } catch { /* nothing to read */ }
  }, true);

  // A trusted click on a Copy button: look for a key in the box beside it.
  document.addEventListener("click", e => {
    if (!e.isTrusted) return;
    const b = /** @type {Element} */ (e.target);
    if (!(b instanceof Element)) return;
    const btn = b.closest('button, [role="button"], a, [data-clipboard-target], [data-copy]');
    if (!btn) return;
    const words = `${btn.getAttribute("aria-label") || ""} ${btn.getAttribute("title") || ""} ${(btn.textContent || "").slice(0, 40)} ${btn.getAttribute("class") || ""}`;
    if (!COPY_WORD.test(words)) return;
    let p = btn.parentElement;
    const pw = passwordValues();
    for (let i = 0; p && i < 4; i++, p = p.parentElement) {
      const found = scan(p).filter(c => !pw.has(c.value));
      if (found.length) { for (const c of found) offer(c); return; }
    }
  }, true);

  document.addEventListener("keydown", e => { if (e.key === "Escape" && host.isConnected) hide(); }, true);
})();
