// @ts-check
// guards: page scripts that run INSIDE a page to answer one yes/no question the extension must
// never get wrong. Plain strings, evaluated with Runtime.evaluate, so they work under any page CSP.

/**
 * Is a password field visible on this page? True for type=password, for a field that declares
 * itself one (autocomplete current-password or new-password), and for a field a "show password"
 * toggle has switched to type=text, which keeps its password-ish name, id, label or placeholder.
 * Looks inside open shadow roots and same-origin iframes. A closed shadow root or a cross-origin
 * frame cannot be read from here, and neither can a script reach into them, so they are the one
 * place this is blind.
 */
export const passwordFieldScript = `(() => {
  const NAME = /(^|[^a-z])(pass(word|wd|code|phrase)?|pwd)([^a-z]|$)/;
  let seen = 0;
  const visible = e => { try { if (!e.getClientRects().length) return false; const s = getComputedStyle(e); return s.visibility !== "hidden" && s.display !== "none"; } catch { return false; } };
  const isPassword = e => {
    const t = String(e.getAttribute("type") || "text").toLowerCase();
    if (t === "password") return true;
    if (/(current|new)-password/.test(String(e.getAttribute("autocomplete") || "").toLowerCase())) return true;
    if (!["text", "search", "tel", "email", "number", ""].includes(t)) return false;
    return NAME.test([e.name, e.id, e.getAttribute("aria-label"), e.placeholder].join(" ").toLowerCase());
  };
  const scan = (root, depth) => {
    if (!root || depth > 6) return false;
    let inputs = [];
    try { inputs = root.querySelectorAll("input"); } catch { return false; }
    for (const e of inputs) { if (++seen > 5000) return false; if (isPassword(e) && visible(e)) return true; }
    let all = [];
    try { all = root.querySelectorAll("*"); } catch { return false; }
    for (const e of all) {
      if (++seen > 20000) return false;
      if (e.shadowRoot && scan(e.shadowRoot, depth + 1)) return true;
      if (e.tagName === "IFRAME" || e.tagName === "FRAME") { let d = null; try { d = e.contentDocument; } catch { d = null; } if (d && scan(d, depth + 1)) return true; }
    }
    return false;
  };
  return scan(document, 0);
})()`;
