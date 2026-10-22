// Stand-in for an agent's screen on the relay's stdio: RFB 3.8, security None, then a small ServerInit.
// Glass is the client (core/computers/rfb.js clientHandshake).
let buf = Buffer.alloc(0);
let step = 0;

function take(/** @type {number} */ n) {
  const b = buf.subarray(0, n);
  buf = buf.subarray(n);
  return b;
}

function pump() {
  if (step === 0 && buf.length >= 12) { take(12); step = 1; process.stdout.write(Buffer.from([1, 1])); }
  if (step === 1 && buf.length >= 1) { take(1); step = 2; process.stdout.write(Buffer.from([0, 0, 0, 0])); }
  if (step === 2 && buf.length >= 1) {
    take(1);
    step = 3;
    const name = Buffer.from("desk");
    const head = Buffer.alloc(24);
    head.writeUInt16BE(1280, 0);
    head.writeUInt16BE(800, 2);
    head.writeUInt32BE(name.length, 20);
    process.stdout.write(Buffer.concat([head, name]));
  }
}

process.stdout.write(Buffer.from("RFB 003.008\n"));
process.stdin.on("data", (/** @type {Buffer} */ c) => { buf = Buffer.concat([buf, c]); pump(); });
process.stdin.resume();
