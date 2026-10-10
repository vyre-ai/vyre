// @ts-check
// bytes: the two small stream pieces every provider shares, a Range header and a byte counter.

import { Transform } from "node:stream";
import { KEY_SNIFF, isKeyBytes } from "./guard.js";

/**
 * One byte range from a Range header against a file of `total` bytes. Null means "send it
 * all" (no header, or a form this does not serve, such as several ranges). A range that starts
 * past the end throws, which the route answers with 416.
 * @returns {{ start: number, end: number } | null}
 */
export function parseRange(header, total) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || "").trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start, end;
  if (m[1] === "") { start = Math.max(0, total - Number(m[2])); end = total - 1; }
  else { start = Number(m[1]); end = m[2] === "" ? total - 1 : Math.min(Number(m[2]), total - 1); }
  if (!Number.isSafeInteger(start) || start >= total || end < start) {
    throw Object.assign(new Error("that range is outside the file"), { code: "range", total });
  }
  return { start, end };
}

/**
 * A pass-through that counts bytes and fails the stream as soon as they pass `max`, so an
 * upload that lies about its size stops at the lie instead of filling the disk.
 * @param {number} max
 */
export function counter(max) {
  const t = new Transform({
    transform(chunk, _enc, done) {
      t.bytes += chunk.length;
      if (t.bytes > max) done(Object.assign(new Error(`the upload is larger than the ${max} bytes it announced`), { code: "too_large" }));
      else done(null, chunk);
    },
  });
  /** @type {any} */ (t).bytes = 0;
  return /** @type {Transform & { bytes: number }} */ (t);
}

/**
 * A pass-through that holds the first bytes of an upload until it can tell whether they are a
 * private key, and fails the stream if they are: Glass does not carry keys onto a computer an
 * agent works in, whatever the file is called.
 */
export function keySniff() {
  /** @type {Buffer[]} */
  let held = [];
  let size = 0, cleared = false;
  const check = () => {
    const head = Buffer.concat(held);
    if (isKeyBytes(head)) return Object.assign(new Error("that file is a private key; Glass does not move keys"), { code: "denied" });
    cleared = true;
    return head;
  };
  return new Transform({
    transform(chunk, _enc, done) {
      if (cleared) return done(null, chunk);
      held.push(chunk); size += chunk.length;
      if (size < KEY_SNIFF) return done();
      const r = check();
      held = [];
      if (r instanceof Error) done(r); else done(null, r);
    },
    flush(done) {
      if (cleared) return done();
      const r = check();
      if (r instanceof Error) done(r); else done(null, r);
    },
  });
}
