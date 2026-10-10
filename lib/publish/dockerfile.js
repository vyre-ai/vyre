// @ts-check
// lib/publish/dockerfile.js: which Dockerfile a build may use (team/contracts/builder.md). Pure text rules, shared by the builder module (core/builder/container.js) and the root host helper's judge
// (core/appmods/host-pub.js), so the module and the helper can never disagree about a Dockerfile.

const refuse = (/** @type {string} */ message, /** @type {string} */ code = "refused") => Object.assign(new Error(message), { code });

/** One Dockerfile line at a time with its continuations joined and comments dropped. @param {string} text @returns {string[]} */
export function instructions(text) {
  /** @type {string[]} */ const out = [];
  let cur = "";
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!cur && (line === "" || line.startsWith("#"))) continue;
    if (cur && line.startsWith("#")) continue;
    if (line.endsWith("\\")) { cur += line.slice(0, -1) + " "; continue; }
    out.push((cur + line).trim()); cur = "";
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * Is this image reference one a build may start from? Docker Official Images (one name, no registry, `library/x`), `scratch`, an earlier stage of the same Dockerfile, and the prefixes the person
 * allowed in the setting `builder.from` (such as `ghcr.io/vyre-ai/`). A build argument in a name (`$X`) is refused: what it starts from must be read here.
 * @param {string} ref @param {Set<string>} stages @param {string[]} allow
 */
export function fromAllowed(ref, stages, allow) {
  if (/[$]/.test(ref)) return false;
  const bare = ref.toLowerCase();
  if (bare === "scratch" || stages.has(bare)) return true;
  const name = bare.replace(/@sha256:[0-9a-f]{64}$/, "").replace(/:[a-z0-9_][a-z0-9_.-]{0,127}$/, "");
  if (!/^[a-z0-9][a-z0-9._\/-]*$/.test(name)) return false;
  if (/^(?:library\/)?[a-z0-9][a-z0-9._-]*$/.test(name)) return true;
  return allow.some(p => typeof p === "string" && p && bare.startsWith(p.toLowerCase()));
}

/**
 * What a Dockerfile asks of a build: refusals (a frontend the folder names, a base that is not allowed, a build mount from outside), and the port it exposes.
 * @param {string} text @param {{ allow?: string[] }} [o]
 * @returns {{ port: number | null, froms: string[] }}
 */
export function checkDockerfile(text, o = {}) {
  const lines = instructions(text);
  // `# syntax=` names an image that runs AS the build frontend: whoever picks it runs its code in the build, so only the one pinned here is used
  if (/^\s*#\s*syntax\s*=/im.test(String(text).split(/\r?\n/).slice(0, 5).join("\n"))) throw refuse("the Dockerfile names its own build frontend (# syntax=); remove that line", "refused");
  /** @type {Set<string>} */ const stages = new Set();
  /** @type {string[]} */ const froms = [];
  let port = null;
  for (const l of lines) {
    const m = /^(\w+)\s*(.*)$/s.exec(l);
    if (!m) continue;
    const op = m[1].toUpperCase(), rest = m[2];
    if (op === "FROM") {
      const parts = rest.split(/\s+/).filter(p => !p.startsWith("--"));
      const ref = parts[0] || "";
      if (!ref) throw refuse("a FROM line names no image: put the image's name after FROM", "refused");
      if (!fromAllowed(ref, stages, o.allow || [])) throw refuse(`the Dockerfile starts from ${ref.slice(0, 80)}, which is not allowed here: copy only files from the app's own folder: use an official image (such as node, python or nginx) or ask the owner to allow its registry`, "refused");
      froms.push(ref);
      const as = /\bAS\s+([A-Za-z0-9_.-]+)\s*$/i.exec(rest);
      if (as) stages.add(as[1].toLowerCase());
    } else if (op === "RUN" || op === "COPY" || op === "ADD") {
      // `COPY --from=<image>` and `RUN --mount=...from=<image>` pull another image into the build: it must pass the same rule as FROM (or be an earlier stage)
      for (const m2 of rest.matchAll(/(?:--from=|\bfrom=)([^\s,]+)/gi)) {
        if (!fromAllowed(m2[1], stages, o.allow || [])) throw refuse(`the Dockerfile takes files from ${m2[1].slice(0, 80)}, which is not allowed here: copy only files from the app's own folder`, "refused");
      }
    } else if (op === "VOLUME") {
      // every VOLUME line is another writable place that lives past the container and has no size limit: the server keeps its data in /data, which Vyre makes and keeps
      throw refuse("the Dockerfile declares a VOLUME: the server keeps its data in /data, which Vyre provides; remove the VOLUME line", "refused");
    } else if (op === "EXPOSE" && port === null) {
      const n = /^(\d{1,5})(?:\/tcp)?\b/i.exec(rest.trim());
      if (n && Number(n[1]) >= 1 && Number(n[1]) <= 65535) port = Number(n[1]);
    }
  }
  if (!froms.length) throw refuse("the Dockerfile has no FROM line: start it with FROM and an image", "refused");
  return { port, froms };
}
