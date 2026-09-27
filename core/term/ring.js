// @ts-check
// ring: a terminal's recent output, addressed by byte offset (ADR 0029, R4).
//
// Every byte a terminal prints has an offset: the first is 0, and the count only grows, across
// reattaches and across a vyred restart (the table keeps it). The ring holds the newest bytes, up
// to `cap` (1 MB by default). When it grows past that it drops old bytes, but only up to the end
// of a line, so a replay never starts halfway through one. It drops a little more than it must
// (a sixteenth of the cap) so a long stream does not rescan the ring on every chunk. A single line
// longer than the ring is the one case cut mid-line.

export class Ring {
  /** @param {number} cap @param {number} [start] the offset of the first byte the ring will hold */
  constructor(cap, start = 0) {
    this.cap = Math.max(1024, Math.floor(cap));
    /** @type {Buffer[]} */ this.chunks = [];
    this.bytes = 0;
    /** The offset of the oldest byte held. */
    this.start = start;
  }

  /** The offset after the newest byte: the terminal's byte count. */
  get end() { return this.start + this.bytes; }

  /** @param {Buffer} b */
  push(b) {
    if (!b.length) return;
    const last = this.chunks[this.chunks.length - 1];
    // Keystroke echoes arrive a few bytes at a time; keep them in fewer, larger chunks.
    if (last && last.length + b.length <= 16 * 1024 && last.length < 16 * 1024) this.chunks[this.chunks.length - 1] = Buffer.concat([last, b]);
    else this.chunks.push(Buffer.from(b));
    this.bytes += b.length;
    if (this.bytes > this.cap) this.trim(this.bytes - (this.cap - (this.cap >> 4)));
  }

  /** Drop at least `need` bytes from the front, up to the end of a line. */
  trim(need) {
    let pos = 0, cut = -1;
    for (const c of this.chunks) {
      if (pos + c.length >= need) {
        const i = c.indexOf(10, Math.max(0, need - 1 - pos));
        if (i >= 0) { cut = pos + i + 1; break; }
      }
      pos += c.length;
    }
    this.drop(cut < 0 ? need : cut);
  }

  /** @param {number} n */
  drop(n) {
    n = Math.min(n, this.bytes);
    this.start += n; this.bytes -= n;
    while (n > 0 && this.chunks.length) {
      const c = this.chunks[0];
      if (c.length <= n) { this.chunks.shift(); n -= c.length; }
      else { this.chunks[0] = c.subarray(n); n = 0; }
    }
  }

  /** The bytes after offset `from` (from the oldest held when `from` is older). */
  since(from) {
    const skip = Math.max(0, Math.min(this.bytes, from - this.start));
    const all = Buffer.concat(this.chunks, this.bytes);
    return all.subarray(skip);
  }

  /** At most the last n bytes, starting at a line when one begins in them. */
  tail(n) {
    if (this.bytes <= n) return this.since(this.start);
    const b = this.since(this.end - n);
    const i = b.indexOf(10);
    return i >= 0 && i + 1 < b.length ? b.subarray(i + 1) : b;
  }

  clear() { this.chunks = []; this.start += this.bytes; this.bytes = 0; }
}
