#!/usr/bin/env node
// fake-mic: stands in for vyre-mic in the talk tests. Writes 100 ms frames of a quiet tone on
// stdout, faster than real time, until stdin closes, then exits 0 as vyre-mic does. With
// FAKE_MIC_FAIL=<code> it writes vyre-mic's one-line JSON error to stderr and exits 1.
const fail = process.env.FAKE_MIC_FAIL;
if (fail) {
  process.stderr.write(JSON.stringify({ code: fail, error: "microphone access is not granted to vyre-mic" }) + "\n");
  process.exit(1);
}
const CHUNK = 3200;
let i = 0;
const frame = () => { const b = Buffer.alloc(CHUNK); for (let k = 0; k < CHUNK / 2; k++) b.writeInt16LE(Math.round(8000 * Math.sin((i * 1600 + k) / 5)), k * 2); i++; return b; };
const timer = setInterval(() => process.stdout.write(frame()), 10);
process.stdin.on("data", () => {});
process.stdin.on("end", () => { clearInterval(timer); process.stdout.end(() => process.exit(0)); });
