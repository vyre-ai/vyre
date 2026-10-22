// @ts-check
// lib/kit-source: what the source of a Kit may be.
//
// A Kit is installed from where a person says it is: a file on their own computer, or an https
// address. The source is a pointer, never a secret: no name and no password in it, no control
// characters (they are invisible and they end a line), no query and no fragment (a signed address
// carries a key in its query), no scheme but https, and it stays short. The terminal and the
// Flows module keep these same rules, so a source the terminal refuses is refused by the
// server too.
//
// A Kit's own text is never a secret either (the kernel refuses one anywhere in it). The source
// holds no key: it says where the Kit is, nothing more.

/** How long a source may be. */
export const MAX_SOURCE = 512;

/** The control characters a source may not carry: they are invisible, and they end a line. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * What a source is, and whether it may be.
 * @param {unknown} text
 * @returns {{ ok: true, kind: "file" | "url", source: string } | { ok: false, why: string }}
 */
export function checkSource(text) {
  const s = typeof text === "string" ? text.trim() : "";
  if (!s) return { ok: false, why: "name the file or the address the Kit is in" };
  if (s.length > MAX_SOURCE) return { ok: false, why: `that source is too long: it may be at most ${MAX_SOURCE} characters` };
  if (CONTROL.test(s)) return { ok: false, why: "a source may not carry control characters: give the file or the address on its own" };
  if (s.includes("@")) return { ok: false, why: "a source may not carry a name or a password: give the file or the address on its own" };
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s);
  if (scheme) {
    const kind = scheme[1].toLowerCase();
    if (kind === "http") return { ok: false, why: "a Kit is fetched over https only: give an https address" };
    if (kind !== "https") return { ok: false, why: "a source is a file path or an https address: give it as one" };
    let url;
    try { url = new URL(s); } catch { return { ok: false, why: "that address is not one a browser would open: give it as https://host/path" }; }
    if (url.username || url.password) return { ok: false, why: "a source may not carry a name or a password: give the address on its own" };
    if (url.search || url.hash) return { ok: false, why: "an address with a query or a fragment is refused: it can carry a key and the source is kept. Give the key through the Vault instead" };
    return { ok: true, kind: "url", source: url.toString() };
  }
  if (s.includes("://")) return { ok: false, why: "a source is a file path or an https address: give it as one" };
  return { ok: true, kind: "file", source: s };
}

/**
 * Whether a word names a Kit to install from a file or an address, rather than one of the Kits
 * this build ships. The rule lives here, with the rest of the source rule: an address is a source,
 * and so is a path (a folder separator, a relative mark, or a .json file). A plain word is the
 * name of a Kit of the library.
 * @param {string} text
 */
export function looksLikeSource(text) {
  const s = String(text || "").trim();
  if (!s) return false;
  const checked = checkSource(s);
  if (checked.ok && checked.kind === "url") return true;
  return s.includes("/") || s.includes("\\") || s.startsWith(".") || s.startsWith("~") || s.endsWith(".json");
}
