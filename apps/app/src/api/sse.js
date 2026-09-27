// @ts-check
// A DOM-free parser for the box's event stream (apps/CONTRACT.md 1.4). Frames look like
// `id: 7\nevent: thread.text\ndata: {...}\n\n`; `: beat` comments are heartbeats. Feed it text
// chunks as they arrive, in any split; it calls onFrame once per complete frame.

/**
 * @typedef {{ id: string|null, event: string, data: string }} Frame
 */

/** @param {(frame: Frame) => void} onFrame */
export function createSseParser(onFrame) {
  let buf = "";
  /** @type {string|null} */ let id = null;
  let event = "";
  /** @type {string[]} */ let data = [];

  function line(/** @type {string} */ l) {
    if (l === "") {
      if (data.length) onFrame({ id, event: event || "message", data: data.join("\n") });
      id = null; event = ""; data = [];
      return;
    }
    if (l.startsWith(":")) return;
    const c = l.indexOf(":");
    const field = c < 0 ? l : l.slice(0, c);
    let value = c < 0 ? "" : l.slice(c + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "id") id = value;
    else if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }

  return {
    /** @param {string} chunk */
    push(chunk) {
      buf += chunk;
      let i;
      while ((i = buf.search(/\r\n|\r|\n/)) >= 0) {
        // A lone \r at the end may be half of a \r\n split across chunks: wait for the next one.
        if (buf[i] === "\r" && i === buf.length - 1) break;
        const nl = buf[i] === "\r" && buf[i + 1] === "\n" ? 2 : 1;
        line(buf.slice(0, i));
        buf = buf.slice(i + nl);
      }
    },
  };
}
