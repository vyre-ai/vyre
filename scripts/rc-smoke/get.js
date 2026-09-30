// GET a path from vyred over its socket, as the CLI would (rc-smoke, run inside the box).
// Prints the status on the first line and the body after it.
const http = require("http");
const [, , p, sock = "/home/vyre/.vyre/vyred.sock"] = process.argv;
http.get({ socketPath: sock, path: p, headers: { "x-vyre-caller": "cli" } }, r => {
  let b = "";
  r.setEncoding("utf8");
  r.on("data", d => (b += d)).on("end", () => { process.stdout.write(`${r.statusCode}\n${b}`); });
}).on("error", e => { process.stdout.write(`000\n${e.message}`); });
