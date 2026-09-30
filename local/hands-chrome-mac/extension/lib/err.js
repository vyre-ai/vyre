// @ts-check
// err: an Error that carries a proto error code, so a capability can throw and the shell can
// answer {ok:false, error:{code, message}} without parsing text.

import { proto } from "./shared.js";

export class VyreError extends Error {
  /**
   * @param {string} code @param {string} [detail] the message
   * @param {any} [data] structured detail (a trace, a redacted page snippet) that rides with the error
   */
  constructor(code, detail, data) {
    super(proto.fail(code, detail).message);
    this.name = "VyreError";
    this.code = code;
    if (data !== undefined) /** @type {any} */ (this).detail = data;
  }
}

/** @param {string} code @param {string} [detail] @param {any} [data] */
export const err = (code, detail, data) => new VyreError(code, detail, data);
