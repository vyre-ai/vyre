// @ts-check
// One name for each place. An old address answers 302 and the route file sends the person on.
// The folded Home routes (needs, doing, planner) are not aliases: those files are gone.

/** @typedef {{ from: string, to: string }} Alias */

/** Old addresses and the one page each opens. A `:name` is one path segment. Longer literal paths win over a pattern of the same length. */
export const ALIASES = Object.freeze(/** @type {readonly Alias[]} */ ([
  { from: "/u", to: "/u/now" },
  { from: "/u/templates", to: "/u/playbooks" },
  { from: "/u/templates/:id", to: "/u/playbooks/:id" },
  { from: "/u/drive", to: "/u/files" },
  { from: "/u/assistants", to: "/u/chats" },
  { from: "/u/assistants/:name", to: "/u/agents/:name" },
  { from: "/u/settings/assistants", to: "/u/chats" },
  { from: "/u/settings/assistants/new", to: "/u/chats" },
  { from: "/u/settings/assistants/:name", to: "/u/agents/:name" },
  { from: "/u/agents", to: "/u/chats" },
  { from: "/u/profile", to: "/u/settings/profile" },
]));

const score = (/** @type {Alias} */ rule) => {
  const segs = rule.from.split("/").filter(Boolean);
  return segs.length * 10 - segs.filter((s) => s.startsWith(":")).length;
};
const ORDERED = [...ALIASES].sort((a, b) => score(b) - score(a));

/**
 * Where an old address goes, or null when it is not an alias.
 * @param {string} path
 * @returns {{ status: 302, to: string } | null}
 */
export function aliasOf(path) {
  const clean = String(path || "").split(/[?#]/)[0].replace(/\/+$/, "") || "/";
  const parts = clean.split("/").filter(Boolean);
  for (const rule of ORDERED) {
    const rp = rule.from.split("/").filter(Boolean);
    if (rp.length !== parts.length) continue;
    /** @type {Record<string, string>} */ const params = {};
    let ok = true;
    for (let i = 0; i < rp.length; i++) {
      if (rp[i].startsWith(":")) params[rp[i].slice(1)] = parts[i];
      else if (rp[i] !== parts[i]) { ok = false; break; }
    }
    if (!ok) continue;
    let to = rule.to;
    for (const [k, v] of Object.entries(params)) {
      let seg = v;
      try { seg = decodeURIComponent(v); } catch { /* keep the segment as written */ }
      to = to.replaceAll(`:${k}`, encodeURIComponent(seg));
    }
    return { status: 302, to };
  }
  return null;
}
