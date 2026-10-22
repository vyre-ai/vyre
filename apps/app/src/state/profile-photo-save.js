// @ts-check
// Save a profile photo: centre-crop, encode on this device, then the Space's profile store. encode and setPhoto are passed in, so a test checks the crop
// and the save without loading the app UI. The screen passes encodePhoto and useProfiles.getState().setPhoto.

import { centreCrop } from "./profile-photo-fit.js";

/**
 * @param {{ uri?: string, width: number, height: number }} pick
 * @param {string} space
 * @param {string} name
 * @param {(pick: any, crop: { originX: number, originY: number, width: number, height: number }) => Promise<{ base64: string, mime: string, bytes: number, side: number }>} encode
 * @param {(space: string, pic: { base64: string, mime: string, bytes: number, side: number }, name: string) => Promise<void>} setPhoto
 */
export async function saveCentrePhoto(pick, space, name, encode, setPhoto) {
  const crop = centreCrop(pick?.width, pick?.height);
  const pic = await encode(pick, crop);
  await setPhoto(space, pic, name);
  return pic;
}
