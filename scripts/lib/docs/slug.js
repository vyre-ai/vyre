// @ts-check
// slug: heading anchors the way GitHub makes them, so a link that works on GitHub works on
// docs.vyre.run and the other way round. scripts/docs-check uses this to check #anchors.
//
// The builder (scripts/lib/docs/markdown.js) writes the ids with its own `slugify`, so this uses
// that one whenever it is there: the checker and the build must never disagree about an anchor.
// The rule itself is GitHub's: take the heading's text as rendered, lowercase it, drop everything
// that is not a letter, a digit, whitespace, a hyphen or an underscore, and turn each whitespace
// character into a hyphen. A repeated slug on one page gets -1, -2 and so on.

/** @param {string} text */
function local(text) {
  return text.toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
}

/** @type {(text: string) => string} */
let base = local;
try {
  const md = await import("./markdown.js");
  if (typeof md.slugify === "function") base = md.slugify;
} catch {}

/** The plain text of a heading's markdown: links, images, code, emphasis and HTML reduced to text. */
export function headingText(md) {
  return String(md)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*{1,3})([^*]+?)\1/g, "$2")
    .replace(/(^|[^\w])_{1,3}([^_]+?)_{1,3}(?=[^\w]|$)/g, "$1$2")
    .trim();
}

/** One heading's slug, before de-duplication. An empty one is "section", as the build does. */
export function slug(md) {
  return base(headingText(md)) || "section";
}

/** A slugger for one page: the same heading twice gets "x", then "x-1". */
export function slugger() {
  /** @type {Set<string>} */
  const seen = new Set();
  return (/** @type {string} */ md) => {
    const b = slug(md);
    let s = b;
    for (let k = 1; seen.has(s); k++) s = `${b}-${k}`;
    seen.add(s);
    return s;
  };
}
