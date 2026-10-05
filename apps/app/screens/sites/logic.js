// Sites and apps, as pure functions. A deployment moves through five pipeline steps; production waits for a person (the Ask before Go live).
// Rolling back and granting a secret are plain edits of the list. Nothing here knows how a build runs.

export const PIPE = ["Build", "Preview", "Checks", "Go live", "Production"];
export const SOURCES = /** @type {const} */ ({ github: "GitHub repo", drive: "Drive folder", artifact: "Assistant artifact" });

/** @typedef {{ v: string, st: 'live'|'preview'|'old', by: string, when: string, msg: string, pipe: ('done'|'cur'|'')[] }} Dep */
/** @typedef {{ id: string, name: string, type: 'App'|'Site', sp: string, src: [string, string, string], dom: { name: string, ok: boolean }, sec: Record<string, boolean>, dep: Dep[], logs: { build: string[], run: string[] } }} Site */

/** @param {Site} s */
export const liveOf = (s) => s.dep.find((d) => d.st === "live");
/** @param {Site} s */
export const previewOf = (s) => s.dep.find((d) => d.st === "preview");

/** True when the preview has passed its checks and is waiting on a person to go live. @param {Site} s */
export const waitingOnYou = (s) => previewOf(s)?.pipe[3] === "cur";

/** @param {Site} s @returns {{ label: string, tone: 'accent'|'plain'|'ok' }} */
export function statusOf(s) {
  const pre = previewOf(s);
  if (pre && pre.pipe[3] === "cur") return { label: "Waiting on you", tone: "accent" };
  if (pre) return { label: "In preview", tone: "plain" };
  return { label: "Live", tone: "ok" };
}

/** Go live: the preview becomes live, the old live becomes history. @param {Site} s */
export function goLive(s) {
  const pre = previewOf(s);
  if (!pre) return s;
  return { ...s, dep: s.dep.map((d) => (d === pre ? { ...d, st: /** @type {const} */ ("live"), pipe: /** @type {Dep['pipe']} */ (["done", "done", "done", "done", "done"]) } : d.st === "live" ? { ...d, st: /** @type {const} */ ("old") } : d)) };
}

/** Roll back to an older version: it goes live, the live one stays in the history. @param {Site} s @param {string} v */
export function rollBack(s, v) {
  if (!s.dep.some((d) => d.v === v)) return s;
  return { ...s, dep: s.dep.map((d) => (d.v === v ? { ...d, st: /** @type {const} */ ("live") } : d.st === "live" ? { ...d, st: /** @type {const} */ ("old") } : d)) };
}

/** @param {Site} s @param {string} name @param {boolean} on */
export const setSecret = (s, name, on) => ({ ...s, sec: { ...s.sec, [name]: on } });

/** Secrets currently granted. @param {Site} s */
export const grantedOf = (s) => Object.keys(s.sec).filter((k) => s.sec[k]);

/** The publish Flow, as text. @param {Site} s */
export function flowText(s) {
  return [
    `flow "Publish ${s.name}"`,
    `  when ${s.src[0].toLowerCase()} changes`,
    "  call build",
    "  call preview.url",
    "  call checks (forms, layout, speed, secrets)",
    '  ask role:admin "Go live?"',
    "  call production.release",
    "  keep previous version for rollback",
  ].join("\n");
}

/** Start a new publication from a source. It begins at the Build step and is not live. @param {Site[]} sites @param {keyof typeof SOURCES} kind @param {string} name */
export function publishNew(sites, kind, name) {
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "new";
  if (sites.some((s) => s.id === id)) return sites;
  /** @type {Site} */
  const s = { id, name, type: kind === "drive" ? "Site" : "App", sp: "harlow", src: [SOURCES[kind], name, "just now"], dom: { name: `${id}.harlowlegal.vyre.run`, ok: true }, sec: {}, dep: [{ v: "v1", st: "preview", by: "alex", when: "Just now", msg: "First version", pipe: ["cur", "", "", "", ""] }], logs: { build: ["Build started."], run: ["Not live yet."] } };
  return [s, ...sites];
}
