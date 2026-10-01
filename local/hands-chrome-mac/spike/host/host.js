// Spike native host. Why: prove Chrome can spawn a registered host, and that a pure byte pipe
// between Chrome's stdio and a local socket (unix socket, or a named pipe on Windows) carries
// framed JSON both ways. The framing on both sides is the same 4-byte length prefix, so this
// reads nothing: it copies bytes, exactly as the design's real host relays frames.
// The wrapper the harness writes sets VYRE_CHROME_SOCK; Chrome's own argv (origin, parent window) is ignored.
import net from "node:net";

const sockPath = process.env.VYRE_CHROME_SOCK;
if (!sockPath) { process.stderr.write("VYRE_CHROME_SOCK not set\n"); process.exit(2); }

const sock = net.connect(sockPath);
sock.on("connect", () => { process.stdin.pipe(sock); sock.pipe(process.stdout); });
sock.on("error", e => { process.stderr.write(`socket: ${e.message}\n`); process.exit(1); });
sock.on("close", () => process.exit(0));
process.stdin.on("end", () => { sock.end(); process.exit(0); });
