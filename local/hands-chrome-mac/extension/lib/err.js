// @ts-check
// err: an Error that carries a proto error code, so a capability can throw and the shell can
// answer {ok:false, error:{code, message}} without parsing text.

import { proto } from "./shared.js";

export class VyreError extends Error {
  /** @param {string} code @param {string} [detail] */
  constructor(code, detail) {
    super(proto.fail(code, detail).message);
    this.name = "VyreError";
    this.code = code;
  }
}

/** @param {string} code @param {string} [detail] */
export const err = (code, detail) => new VyreError(code, detail);
