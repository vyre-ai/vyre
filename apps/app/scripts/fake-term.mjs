// A fake term socket for the terminal demo and its screenshots: the protocol of core/term (offsets, at, size, take), replaying a canned
// coloured session (ls, git, a test run) and echoing what is typed. No pty, no shell, nothing real.
//   node scripts/fake-term.mjs [port]      listens on 127.0.0.1 (default 7391); ws://127.0.0.1:<port>/pty?from=<offset>
import http from "node:http";
import { acceptKey, encodeFrame, FrameParser } from "../../../lib/ws.js";

const C = (n, s) => `\x1b[${n}m${s}\x1b[0m`;
const prompt = `${C("1;32", "alex@juno")}:${C("1;34", "~/juniper-site")}$ `;
export const CANNED = [
  `${prompt}ls -la\r\n`,
  `total 48\r\n`,
  `drwxr-xr-x  6 alex alex 4096 Oct  3 14:02 ${C("1;34", ".")}\r\n`,
  `drwxr-xr-x 14 alex alex 4096 Oct  3 13:40 ${C("1;34", "..")}\r\n`,
  `-rw-r--r--  1 alex alex  412 Oct  3 14:02 package.json\r\n`,
  `drwxr-xr-x  3 alex alex 4096 Oct  3 13:58 ${C("1;34", "src")}\r\n`,
  `-rwxr-xr-x  1 alex alex  188 Oct  3 13:41 ${C("1;32", "deploy.sh")}\r\n`,
  `lrwxrwxrwx  1 alex alex   11 Oct  3 13:41 ${C("1;36", "latest")} -> build/v12\r\n`,
  `${prompt}git status -sb\r\n`,
  `## main...origin/main [ahead 2]\r\n`,
  ` ${C("31", "M")} src/pages/contact.tsx\r\n`,
  `${C("32", "M")}  src/components/Hero.tsx\r\n`,
  `${C("31", "??")} notes/draft.md\r\n`,
  `${prompt}npm test\r\n`,
  `\r\n> juniper-site@1.4.0 test\r\n> node --test\r\n\r\n`,
  `${C("32", "✔")} hero renders the firm name ${C("90", "(3.1ms)")}\r\n`,
  `${C("32", "✔")} contact form posts to the intake ${C("90", "(11.8ms)")}\r\n`,
  `${C("31", "✖")} sitemap lists every practice area ${C("90", "(2.2ms)")}\r\n`,
  `  ${C("2;31", "expected 9 urls, got 8: /areas/probate is missing")}\r\n`,
  `\r\n${C("1", "tests")} 3   ${C("32", "pass")} 2   ${C("31", "fail")} 1\r\n`,
  `${prompt}`,
].join("");
const ALL = Buffer.from(CANNED);

export function serve(port = 7391) {
  const srv = http.createServer((_q, r) => { r.writeHead(404); r.end(); });
  srv.on("upgrade", (req, socket) => {
    const url = new URL(req.url || "/", "http://x");
    const key = req.headers["sec-websocket-key"];
    if (!key) { socket.destroy(); return; }
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
    const text = (m) => socket.write(encodeFrame(Buffer.from(JSON.stringify(m)), 0x1));
    let end = ALL.length, cols = 80, rows = 24, owner = true;
    const from = Number(url.searchParams.get("from") || 0);
    const start = Math.min(Number.isSafeInteger(from) && from >= 0 ? from : 0, end);
    const rest = ALL.subarray(start);
    for (let i = 0; i < rest.length; i += 1024) socket.write(encodeFrame(rest.subarray(i, i + 1024)));
    text({ t: "at", offset: end });
    text({ t: "size", cols, rows, owner });
    const parser = new FrameParser();
    socket.on("data", (chunk) => {
      let frames; try { frames = parser.push(chunk); } catch { socket.destroy(); return; }
      for (const f of frames) {
        if ("control" in f) { if (f.control === "close") socket.end(); continue; }
        let m; try { m = JSON.parse(f.message.toString("utf8")); } catch { continue; }
        if (m.t === "in") {
          const out = Buffer.from(String(m.d).replace(/\r/g, "\r\n" + prompt));
          end += out.length;
          socket.write(encodeFrame(out));
        } else if (m.t === "size") { cols = m.cols; rows = m.rows; text({ t: "size", cols, rows, owner }); }
        else if (m.t === "take") { owner = true; text({ t: "size", cols, rows, owner }); }
      }
    });
    socket.on("error", () => {});
  });
  return new Promise((resolve) => srv.listen(port, "127.0.0.1", () => resolve(srv)));
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const port = Number(process.argv[2] || 7391);
  await serve(port);
  console.log(`fake term socket on ws://127.0.0.1:${port}/pty`);
}
