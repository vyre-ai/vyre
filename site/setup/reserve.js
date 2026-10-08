// @ts-check
// reserve: the rules of the one thing this page does. A person picks a name, the directory checks it and holds it for 24 hours behind a
// code, and the Vyre app on their device pastes that code to make the name's key. The page makes no key and keeps nothing: the code is
// shown once, in this tab.

export const DIRECTORY = "https://names.vyre.run";
/** The directory's code alphabet (names/worker/ids.js ALPHA32): A-Z without I and O, then 2-9. reserve.test.js checks it against the Worker. */
export const CODE_RE = /^VYRE(-[A-HJ-NP-Z2-9]{4}){4}$/;
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/** What the person typed, as a name to ask about ("" when nothing usable). @param {string} text */
export const nameOf = text => String(text || "").trim().toLowerCase().replace(/\.vyre\.run$/, "");

/** Could this be a name at all (the directory has the last word)? @param {string} name */
export const looksLikeName = name => name.length >= 3 && NAME.test(name);

/** The directory's check, as the page says it. @param {number} status @param {any} body @returns {"free" | "taken" | "invalid" | "unknown"} */
export function checkAnswer(status, body) {
  const st = status === 200 && body && body.data && typeof body.data.status === "string" ? body.data.status : "";
  if (st === "ok" || st === "mine") return "free";
  if (st === "taken" || st === "reserved") return "taken";
  if (st === "invalid") return "invalid";
  return "unknown";
}

/** The directory's answer to a reservation: the code, or the plain reason there is none. @param {number} status @param {any} body @returns {{ ok: true, code: string, expires: number } | { ok: false, say: string }} */
export function reserveAnswer(status, body) {
  const d = body && body.data;
  if (status === 200 && d && typeof d.code === "string" && CODE_RE.test(d.code)) return { ok: true, code: d.code, expires: Number(d.expires) || 0 };
  if (status === 429) return { ok: false, say: "Too many names were reserved from this connection today. Try again tomorrow." };
  if (status === 409) return { ok: false, say: "Someone else holds that name. Pick another." };
  return { ok: false, say: "Vyre could not reserve that name just now. Try again in a minute." };
}

export const MESSAGES = {
  free: "That name is free.",
  taken: "That name is taken. Pick another.",
  invalid: "Names are 3 to 32 letters, numbers or hyphens, and start and end with a letter or number.",
  unknown: "Vyre could not check that name just now.",
};

/** @param {number} expires epoch ms @param {number} now */
export const lasts = (expires, now) => { const h = Math.max(1, Math.round((expires - now) / 3_600_000)); return `${h} hours`; };
