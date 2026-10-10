// @ts-check
// published: a deployment Publish made from a Dockerfile (team/contracts/builder.md, the container path) as an app module. The manifest is made in memory from the deployment and checked by the same
// rules every catalog manifest is (manifest.js), plus the few that are only about an image Vyre built: it is named by its local image id, it owns one data volume, it may be open to strangers
// (every method and path, no owner ticket, never the owner's session) and its root is read-only. Nothing here starts anything.
import { checkAppModule, NAME_RE } from "./manifest.js";
import { RESERVED_LABELS } from "../../lib/publish/hostname.js";

export const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
/** The most a published app may ask for: more than a catalog service, less than the server. */
export const CEILING = Object.freeze({ memoryMb: 2048, cpus: 2, pids: 512 });
export const DEFAULTS = Object.freeze({ memoryMb: 512, cpus: 0.5, pids: 256 });
const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
/** Never a name of its own: a preview's. */
const PREVIEW_NAME = /^pv-[0-9a-f]{8}$/;

const refuse = (/** @type {string} */ message, /** @type {string} */ code = "bad_input") => Object.assign(new Error(message), { code });

/**
 * The manifest of a published app. `catalogNames` are the names of the catalog apps (never taken over).
 * @param {any} d the deployment { id, name, version, runtime: { kind: "image", image, port, health }, secrets?: names[], limits? }
 * @param {{ catalogNames: Iterable<string>, public?: boolean }} o
 */
export function publishedManifest(d, o) {
  const rt = d && d.runtime;
  if (!d || typeof d !== "object" || typeof d.id !== "string" || !/^dep_[0-9a-f]{16}$/.test(d.id)) throw refuse("not a deployment");
  if (!rt || rt.kind !== "image" || !IMAGE_ID.test(String(rt.image || ""))) throw refuse("this deployment is not a built image: Publish runs a server from the image its builder made");
  const name = String(d.name || "");
  if (!NAME_RE.test(name)) throw refuse("a server's name is lowercase letters, digits and dashes, 2 to 31 characters");
  if ([...o.catalogNames].includes(name)) throw refuse(`${name} is the name of an app that ships with Vyre; name the site something else`);
  if (PREVIEW_NAME.test(name) || RESERVED_LABELS.includes(name)) throw refuse(`${name} is a name Vyre keeps for itself; name the site something else`);
  const secrets = Array.isArray(d.secrets) ? d.secrets.map(String) : [];
  for (const s of secrets) if (!SECRET_NAME.test(s)) throw refuse(`${s} is not a name an environment variable can have`);
  if (new Set(secrets).size !== secrets.length) throw refuse("a secret is named twice");
  const asked = d.limits && typeof d.limits === "object" ? d.limits : {};
  const limits = { memoryMb: asked.memoryMb ?? DEFAULTS.memoryMb, cpus: asked.cpus ?? DEFAULTS.cpus, pids: asked.pids ?? DEFAULTS.pids };
  for (const k of /** @type {const} */ (["memoryMb", "cpus", "pids"])) if (typeof limits[k] !== "number" || !(limits[k] > 0) || limits[k] > CEILING[k]) throw refuse(`${k} is at most ${CEILING[k]} for a published server`);
  const h = rt.health && typeof rt.health === "object" ? rt.health : {};
  const health = { path: typeof h.path === "string" ? h.path : "/", ok: Array.isArray(h.ok) && h.ok.length ? h.ok : [200, 301, 302, 401, 403, 404], startS: 60 };
  return {
    name, version: `0.0.${Number.isInteger(d.version) && d.version > 0 ? d.version : 1}`, vyre: "1",
    description: `${name}, published from this server's Publish.`,
    "x-publish": { deployment: d.id, secrets, ...(o.public ? { public: true } : {}) },
    app: { image: rt.image, port: Number(rt.port), volumes: [{ name: "data", path: "/data" }], health, limits, readOnly: true, ...(o.public ? { open: true } : {}) },
  };
}

/**
 * Check a published manifest with the catalog's own rules (the image is judged by its own rule, since the catalog's wants a registry digest).
 * @param {any} m @returns {{ path: string, message: string }[]}
 */
export function checkPublished(m) {
  if (!m || typeof m !== "object" || !m["x-publish"] || !m.app) return [{ path: "", message: "not a published app" }];
  const out = checkAppModule({ ...m, app: { ...m.app, image: `local/x@sha256:${"0".repeat(64)}` } });
  if (!IMAGE_ID.test(String(m.app.image))) out.push({ path: "app.image", message: "the image is the build's local id: sha256:<64 hex>" });
  return out;
}
