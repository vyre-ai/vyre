// @ts-check
// Errors that name the place and the fix (e4). A problem from the checks is { path, message }, sometimes with the name that was wrong (`bad`) and the names that would have been right
// (`choices`). `decorate` turns each into { path, message, step?, fix? }: the message leads with the step ("Step 3 (make_letter): ...") and ends with a suggestion when a real name is close
// ("did you mean client?"), or with the choices when none is. The old path and message fields still hold for any reader.

/** Edit distance, stopping early past `max`. @param {string} a @param {string} b @param {number} max */
function distance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let low = i;
    for (let j = 1; j <= b.length; j++) { const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); cur.push(v); if (v < low) low = v; }
    if (low > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** The listed name closest to `name`: within two edits, or one that starts the other. @param {string} name @param {string[]} list @returns {string | null} */
export function nearest(name, list) {
  const n = String(name).toLowerCase();
  let best = null, bestD = 3;
  for (const c of list) {
    const l = String(c).toLowerCase();
    const d = l === n ? 0 : (n.length >= 3 && (l.startsWith(n) || n.startsWith(l))) ? 1 : distance(n, l, 2);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

/** The step a problem's path is inside: its number ("3", or "3.1" inside a block), and its id. @param {any} flow @param {string} path @returns {{ n: string, id: string } | null} */
export function placeOf(flow, path) {
  const m = /^(steps|on_failure)((?:\[\d+\](?:\.(?:then|else|steps)|\.on_fail\.steps)?)+)/.exec(path || "");
  if (!m) return null;
  /** @type {any[]} */ let list = m[1] === "steps" ? flow.steps : flow.on_failure;
  /** @type {number[]} */ const at = [];
  let id = "";
  const re = /\[(\d+)\](?:\.(then|else|steps)|\.on_fail\.(steps))?/g;
  let x;
  while ((x = re.exec(m[2]))) {
    const s = Array.isArray(list) ? list[Number(x[1])] : null;
    if (!s) return null;
    at.push(Number(x[1]) + 1); id = String(s.id);
    const into = x[2] ? s[x[2]] : x[3] ? (s.on_fail && s.on_fail.steps) : null;
    list = into;
  }
  return at.length ? { n: (m[1] === "on_failure" ? "on_failure " : "") + at.join("."), id } : null;
}

/**
 * @param {any} flow @param {{ path: string, message: string, bad?: string, choices?: string[] }[]} problems
 * @returns {{ path: string, message: string, step?: string, fix?: string }[]}
 */
export function decorate(flow, problems) {
  return problems.map((p) => {
    const where = placeOf(flow, p.path);
    /** @type {string | undefined} */ let fix;
    if (p.choices && p.choices.length) {
      const close = p.bad !== undefined ? nearest(p.bad, p.choices) : null;
      fix = close ? `did you mean ${close}?` : `the choices are ${p.choices.slice(0, 5).join(", ")}${p.choices.length > 5 ? " and more" : ""}`;
    }
    const lead = where ? `Step ${where.n} (${where.id}): ` : "";
    return { path: p.path, message: `${lead}${p.message}${fix ? `; ${fix}` : ""}`, ...(where ? { step: where.id } : {}), ...(fix ? { fix } : {}) };
  });
}
