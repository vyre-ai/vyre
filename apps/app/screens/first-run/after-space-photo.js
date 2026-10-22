// @ts-check
// The photo step after a Space is online. A chosen picture is centre-cropped and saved as this Space's member photo through the same helper Your profile
// uses (src/state/profile-photo-save.js), which the screen calls with profiles.setPhoto. Skip goes on. A GitHub sign-in that kept an avatar offers it.

import { afterSpace } from "../../../../lib/first-run-shape.js";
import { saveCentrePhoto } from "../../src/state/profile-photo-save.js";
import { AFTER_COPY } from "./after-space-copy.js";

/**
 * What the step offers. GitHub's photo is offered only when this sign-in kept one (the address check happens where GitHub fills it).
 * @param {any} status identity.status: github (or githubLogin) and photo
 */
export function photoOffer(status) {
  const row = status && typeof status === "object" ? status : {};
  const github = row.github || row.githubLogin;
  const photo = github && typeof row.photo === "string" ? row.photo.trim() : "";
  return {
    choose: AFTER_COPY.photoChoose,
    skip: AFTER_COPY.photoSkip,
    ...(photo ? { github: { label: AFTER_COPY.photoGithub, photo } } : {}),
  };
}

/** Skip for now: the next screen, and nothing is saved. */
export function photoSkipped() {
  return afterSpace("setup.photo");
}

/**
 * The Space the photo belongs to. The one the screen already has wins; otherwise the current Space, then the first listed.
 * @param {unknown} have @param {any} listed onboard.space.list
 */
export function spaceForPhoto(have, listed) {
  const given = typeof have === "string" ? have.trim() : "";
  if (given) return given;
  const cur = listed && typeof listed.current === "string" ? listed.current.trim() : "";
  if (cur) return cur;
  const rows = listed && Array.isArray(listed.spaces) ? listed.spaces : [];
  const hit = rows.find((/** @type {any} */ s) => s && typeof s.id === "string" && s.id.trim());
  return hit ? String(hit.id).trim() : "";
}

/**
 * The picture the person chose, saved as this Space's member photo. setPhoto is profiles.setPhoto. encode draws the centre square down on this computer.
 * @param {{ uri?: string, width: number, height: number }} pick
 * @param {string} space
 * @param {string} name
 * @param {(pick: any, crop: { originX: number, originY: number, width: number, height: number }) => Promise<{ base64: string, mime: string, bytes: number, side: number }>} encode
 * @param {(space: string, pic: { base64: string, mime: string, bytes: number, side: number }, name: string) => Promise<void>} setPhoto
 */
export function saveChosenPhoto(pick, space, name, encode, setPhoto) {
  return saveCentrePhoto(pick, space, typeof name === "string" ? name.trim() : "", encode, setPhoto);
}
