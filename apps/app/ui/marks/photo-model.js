// @ts-check
// A person's profile photo where their face is drawn (ui/components/Avatar.tsx). Pure: which photo a face is (only a person's, never an agent's), what the Avatar draws (the photo once it is
// here, else the face, so nothing moves when it arrives), and the small cache that keeps each photo once per run. A photo's id names one picture for good (records/core-types.js MEMBER_PHOTO), so
// a cached photo never goes stale: a new photo is a new id.

/** @typedef {{ kind: string, id: string, name: string }} Who */

/**
 * The photo address for a face, or "" when it has none: a person only (an agent, the assistant and a teammate keep their looks), by person id first, then by name.
 * @param {Who | null | undefined} of @param {Record<string, string>} photos @param {boolean} [face] the caller asks for the look itself (the look picker's preview)
 */
export function photoRef(of, photos, face = false) {
  if (!of || face || of.kind !== "person") return "";
  return photos[of.id] || (of.name ? photos[String(of.name).toLowerCase()] : "") || "";
}

/**
 * What a face draws: a person's photo when they have one and it is here, else the face (also while the photo is on its way, so the box is the same size and nothing jumps). An agent is always its look.
 * @param {Who} of @param {string | undefined} uri the photo as a data address, "" while there is none @param {boolean} [face] the caller asks for the look itself
 * @returns {{ photo: string } | { face: true }}
 */
export function picture(of, uri, face = false) {
  return of && of.kind === "person" && !face && uri && /^data:image\/(webp|jpeg|png);base64,/.test(uri) ? { photo: uri } : { face: true };
}

/** A photo record's answer as a data address the Image draws, or "" (wiped, not a picture, or not there). @param {any} answer */
export function dataUri(answer) {
  const d = answer && answer.record && answer.record.data;
  const image = d && typeof d.image === "string" ? d.image : "";
  const mime = d && typeof d.mime === "string" && /^image\/(webp|jpeg|png)$/.test(d.mime) ? d.mime : "";
  return image && mime && /^[A-Za-z0-9+/]+={0,2}$/.test(image) ? `data:${mime};base64,${image}` : "";
}

/**
 * The photos read in this run, by address, the most recent kept (each is at most 200 KB, and lists draw the same few faces). A photo is read once: two faces asking at once share one read, and one
 * that could not be read is kept as "" so a list does not ask again for every row.
 * @param {{ max?: number }} [o]
 */
export function createPhotoCache(o = {}) {
  const max = o.max ?? 64;
  /** @type {Map<string, string>} */ const kept = new Map();
  /** @type {Map<string, Promise<string>>} */ const reading = new Map();
  const keep = (/** @type {string} */ ref, /** @type {string} */ uri) => {
    kept.delete(ref); kept.set(ref, uri);
    while (kept.size > max) kept.delete(/** @type {string} */ (kept.keys().next().value));
  };
  return {
    /** The photo when it is here (undefined while it is not). @param {string} ref */
    get: (ref) => kept.get(ref),
    /** Read a photo once. @param {string} ref @param {(ref: string) => Promise<string>} read */
    load(ref, read) {
      const have = kept.get(ref);
      if (have !== undefined) return Promise.resolve(have);
      const on = reading.get(ref);
      if (on) return on;
      const p = read(ref).catch(() => "").then((uri) => { reading.delete(ref); keep(ref, uri || ""); return uri || ""; });
      reading.set(ref, p);
      return p;
    },
    /** Put a photo the person just saved, so their own face changes at once. @param {string} ref @param {string} uri */
    put: (ref, uri) => keep(ref, uri),
    size: () => kept.size,
  };
}
