// The fake screen the Android proof watches (apps/app/scripts/glass-relay-android.sh): a minimal RFB server (the fake Xvnc the Glass tests use) behind a WebSocket on 0.0.0.0:5999, the way Glass puts a screen on a
// socket. It repaints a solid grey screen every second so the page has a frame to draw whenever it connects. Run on the CI host; the emulator reaches it as 10.0.2.2.
import http from "node:http";
import net from "node:net";
import { fakeXvnc } from "../../../test/fixtures/fake-xvnc.js";
import { upgradeHead, encodeFrame, FrameParser } from "../../../lib/ws.js";

const xvnc = await fakeXvnc({ width: 320, height: 240, name: "proof screen" });
const server = http.createServer((q, r) => { console.log("http probe", q.url); r.writeHead(404); r.end(); });
server.on("upgrade", (req, socket) => {
  const key = String(req.headers["sec-websocket-key"] || "");
  socket.write(upgradeHead(key, req.headers["sec-websocket-protocol"] ? "Sec-WebSocket-Protocol: binary\r\n" : ""));
  const tcp = net.connect(xvnc.port, "127.0.0.1");
  const parser = new FrameParser({ masked: true });
  tcp.on("data", d => { try { socket.write(encodeFrame(d, 2, false)); } catch { /* gone */ } });
  socket.on("data", d => { try { for (const m of parser.push(d)) if ("message" in m) tcp.write(m.message); } catch { socket.destroy(); } });
  const done = () => { tcp.destroy(); socket.destroy(); };
  socket.on("close", done); socket.on("error", done); tcp.on("close", done); tcp.on("error", done);
  console.log("watcher connected");
});
setInterval(() => xvnc.sendFrame(), 1000).unref();
server.listen(5999, "0.0.0.0", () => console.log("READY"));
