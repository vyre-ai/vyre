// @ts-check
// wire: one line-and-bytes conversation over TCP or TLS, for the IMAP and SMTP clients and for
// the test fakes. Every read has a deadline; a closed or failed socket fails the read that waits.
// STARTTLS swaps the socket underneath, and refuses bytes the server sent before TLS began (they
// could be a response an attacker injected in the clear).

import net from "node:net";
import tls from "node:tls";

export class MailError extends Error {
  /** @param {string} message @param {string} [code] */
  constructor(message, code = "failed") { super(message); this.code = code; }
}

const CRLF = Buffer.from("\r\n");

export class Wire {
  /** @param {net.Socket} socket @param {{ timeout?: number, what?: string }} [opts] */
  constructor(socket, { timeout = 20_000, what = "the server" } = {}) {
    this.timeout = timeout;
    this.what = what;
    this.buf = Buffer.alloc(0);
    /** @type {Error|null} */
    this.dead = null;
    /** @type {(() => void)|null} */
    this.wake = null;
    this.attach(socket);
  }

  /** @param {net.Socket} socket */
  attach(socket) {
    this.socket = socket;
    this.onData = chunk => { this.buf = Buffer.concat([this.buf, chunk]); this.poke(); };
    this.onEnd = () => { this.dead = this.dead || new MailError(`${this.what} closed the connection`, "closed"); this.poke(); };
    this.onError = e => { this.dead = new MailError(`${this.what}: ${e.message}`, /** @type {any} */ (e).code === "ECONNREFUSED" ? "unreachable" : "failed"); this.poke(); };
    socket.on("data", this.onData);
    socket.on("end", this.onEnd);
    socket.on("close", this.onEnd);
    socket.on("error", this.onError);
  }

  detach() {
    const s = this.socket;
    s.off("data", this.onData); s.off("end", this.onEnd); s.off("close", this.onEnd); s.off("error", this.onError);
    // A socket with no error listener would throw an unhandled error; keep one.
    s.on("error", () => {});
  }

  poke() { const w = this.wake; this.wake = null; if (w) w(); }

  /** Wait until `ready()` returns something other than undefined, or fail at the deadline. */
  async until(ready) {
    const at = Date.now() + this.timeout;
    for (;;) {
      const v = ready();
      if (v !== undefined) return v;
      if (this.dead) throw this.dead;
      const left = at - Date.now();
      if (left <= 0) throw new MailError(`${this.what} did not answer within ${Math.round(this.timeout / 1000)} s`, "timeout");
      await new Promise(resolve => {
        const t = setTimeout(resolve, left);
        this.wake = () => { clearTimeout(t); resolve(undefined); };
      });
    }
  }

  /** One line without its CRLF (a bare LF is accepted too). Caps a line at 1 MB. */
  readLine() {
    return this.until(() => {
      const i = this.buf.indexOf(10);
      if (i < 0) {
        if (this.buf.length > 1 << 20) throw new MailError(`${this.what} sent a line over 1 MB`, "protocol");
        return undefined;
      }
      const line = this.buf.subarray(0, i > 0 && this.buf[i - 1] === 13 ? i - 1 : i).toString("utf8");
      this.buf = this.buf.subarray(i + 1);
      return line;
    });
  }

  /** Exactly n bytes. @param {number} n @returns {Promise<Buffer>} */
  readBytes(n) {
    return this.until(() => {
      if (this.buf.length < n) return undefined;
      const out = Buffer.from(this.buf.subarray(0, n));
      this.buf = this.buf.subarray(n);
      return out;
    });
  }

  /** @param {string|Buffer} data */
  write(data) {
    if (this.dead) throw this.dead;
    this.socket.write(typeof data === "string" ? Buffer.from(data, "utf8") : data);
  }

  /** @param {string} line */
  writeLine(line) { this.write(Buffer.concat([Buffer.from(line, "utf8"), CRLF])); }

  /**
   * Start TLS on this connection. The client side verifies the server's certificate.
   * @param {{ host: string, ca?: string }} opts
   */
  async startTls({ host, ca }) {
    if (this.buf.length) throw new MailError(`${this.what} sent data before TLS started; refusing the connection`, "protocol");
    this.detach();
    const secure = tls.connect({ socket: this.socket, ...tlsNames(host), ...(ca ? { ca } : {}) });
    await handshake(secure, this.what, this.timeout);
    this.attach(secure);
  }

  close() {
    try { this.socket.end(); } catch {}
    const s = this.socket;
    setTimeout(() => { try { s.destroy(); } catch {} }, 200).unref();
  }
}

/** servername only for a name: TLS SNI never carries an IP address. @param {string} host */
const tlsNames = host => (net.isIP(host) ? {} : { servername: host });

/** @param {tls.TLSSocket} s @param {string} what @param {number} timeout */
function handshake(s, what, timeout) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { s.destroy(); reject(new MailError(`${what} did not finish TLS within ${Math.round(timeout / 1000)} s`, "timeout")); }, timeout);
    s.once("secureConnect", () => { clearTimeout(t); resolve(undefined); });
    s.once("error", e => { clearTimeout(t); reject(new MailError(`${what}: TLS failed: ${e.message}`, "tls")); });
  });
}

/**
 * Connect, in TLS from the first byte when `tls` is true.
 * @param {{ host: string, port: number, tls?: boolean, ca?: string, timeout?: number, what?: string }} o
 */
export async function connect({ host, port, tls: implicit = false, ca, timeout = 20_000, what = "the server" }) {
  if (implicit) {
    const s = tls.connect({ host, port, ...tlsNames(host), ...(ca ? { ca } : {}) });
    await handshake(s, what, timeout);
    return new Wire(s, { timeout, what });
  }
  const s = net.connect({ host, port });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => { s.destroy(); reject(new MailError(`${what} at ${host}:${port} did not answer within ${Math.round(timeout / 1000)} s`, "timeout")); }, timeout);
    s.once("connect", () => { clearTimeout(t); resolve(undefined); });
    s.once("error", e => { clearTimeout(t); reject(new MailError(`could not reach ${what} at ${host}:${port}: ${e.message}`, "unreachable")); });
  });
  return new Wire(s, { timeout, what });
}
