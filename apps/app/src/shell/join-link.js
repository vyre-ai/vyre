// @ts-check
import { holdJoin } from "./join-hold.js";
// The web join page's "Open in Vyre" gives vyre://join?link=<url-encoded https join link>. Only an https link of a space's own join path goes on to the box
// to be verified (the token is payload.signature, so it holds a dot); anything else lands on the plain Join screen with nothing filled in.

/** @param {unknown} raw the `link` query value, already decoded once by the router @returns {string | null} */
export function joinLink(raw) {
  const s = Array.isArray(raw) ? String(raw[0] ?? "") : typeof raw === "string" ? raw : "";
  let u;
  try { u = new URL(decodeURIComponent(s) === s ? s : decodeURIComponent(s)); } catch { return null; }
  return u.protocol === "https:" && /^\/join\/[A-Za-z0-9_.-]+\/?$/.test(u.pathname) ? u.toString() : null;
}

/** Where the app goes for that link: the link is held in memory and never put in the address. @param {unknown} raw */
export function joinTarget(raw) {
  const l = joinLink(raw);
  if (l) holdJoin(l);
  return "/u/install/join";
}
