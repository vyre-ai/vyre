// @ts-check
// /a/<id>?v=N: an artifact full screen, with its version bar (chat/cards/artifact.js). The page the
// phone opens from an artifact card, and the address a shared link's owner can open on the box.

import { put } from "../js/dom.js";
import { artifactScreen } from "../chat/cards/artifact.js";

/** @param {any} ctx */
export default async function artifact(ctx) {
  const v = Number(ctx.query?.get?.("v"));
  const screen = artifactScreen(String(ctx.params.id || ""), Number.isInteger(v) && v > 0 ? v : null, {});
  ctx.cleanup(() => screen.dispose());
  put(ctx.root, screen);
}
