// @ts-check
// guards: page scripts that run INSIDE a page to answer one yes/no question the extension must
// never get wrong. Plain strings, evaluated with Runtime.evaluate, so they work under any page CSP.

/**
 * Is a password field visible on this page? True for type=password, for a field that declares
 * itself one (autocomplete current-password or new-password), and for a field a "show password"
 * toggle has switched to type=text, which keeps its password-ish name, id, label or placeholder.
 * Looks inside open shadow roots and same-origin iframes. A page with more than 5000 inputs or 20000 elements, or any error while looking, counts as yes (fail closed). A closed shadow root or a cross-origin
 * frame cannot be read from here, and neither can a script reach into them, so they are the one
 * place this is blind.
 */
export const passwordFieldScript = `(() => {
  const NAME = /(^|[^a-z])(pass(word|wd|code|phrase)?|pwd)([^a-z]|$)/;
  let seen = 0, over = false;
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
    try { inputs = root.querySelectorAll("input"); } catch { over = true; return false; }
    for (const e of inputs) { if (++seen > 5000) { over = true; return false; } if (isPassword(e) && visible(e)) return true; }
    let all = [];
    try { all = root.querySelectorAll("*"); } catch { over = true; return false; }
    for (const e of all) {
      if (++seen > 20000) { over = true; return false; }
      if (e.shadowRoot && scan(e.shadowRoot, depth + 1)) return true;
      if (e.tagName === "IFRAME" || e.tagName === "FRAME") { let d = null; try { d = e.contentDocument; } catch { d = null; } if (d && scan(d, depth + 1)) return true; }
    }
    return false;
  };
  // A page too big to look through, or one this script cannot read, is treated as a password page: fail closed.
  try { return scan(document, 0) || over; } catch { return true; }
})()`;


/** A script that opens the page's auth stores. A tripwire, not a wall: what it stops is the plain way; the write-hold and redaction cover the rest. */
export const CREDENTIAL_STORE = /firebaseLocalStorage|stsTokenManager|firebase:authUser|\b(?:access|refresh|id)[_-]?token\b.{0,80}(?:indexedDB|localStorage|sessionStorage)|(?:indexedDB|localStorage|sessionStorage).{0,200}(?:access|refresh|id)[_-]?token|document\.cookie/is;
