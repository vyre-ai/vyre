// kernel/seal/serve.js: the sealing process. Newline-delimited JSON on stdin and stdout, one request per line:
//   {"id":1,"op":"init","args":{"key":"<b64>","ticket_key":"<b64>","dir":"...","egress_dir":"..."}}   (first, once)
//   {"id":2,"op":"put","args":{...}}  ->  {"id":2,"ok":true,"result":{...}}  or  {"id":2,"ok":false,"error":{"code":"...","message":"..."}}
// The protocol is the contract with any implementation of this process (the Node one here, or a later Rust one): the
// conformance tests in kernel/seal run against whatever command they are given. It writes nothing to stderr but a
// fixed line on a crash, never a stack, a value or a request.
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { createSealEngine, SealError } from "./engine.js";

process.on("uncaughtException", () => { process.stderr.write("seal: internal error\n"); process.exit(70); });
process.on("unhandledRejection", () => { process.stderr.write("seal: internal error\n"); process.exit(70); });

/** @type {ReturnType<typeof createSealEngine> | null} */ let engine = null;
let egressDir = null;
const out = (/** @type {any} */ o) => process.stdout.write(JSON.stringify(o) + "\n");

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", line => {
  let req;
  try { req = JSON.parse(line); } catch { return out({ id: null, ok: false, error: { code: "bad_request", message: "not json" } }); }
  const { id, op, args, ticket } = req;
  try {
    if (op === "init") {
      if (engine) throw new SealError("already_init", "already started");
      egressDir = args.egress_dir || null;
      if (egressDir) fs.mkdirSync(egressDir, { recursive: true });
      engine = createSealEngine({
        key: Buffer.from(args.key, "base64url"), ticket_key: Buffer.from(args.ticket_key, "base64url"), dir: args.dir,
        egress: ({ output_ref, text }) => { if (egressDir) fs.writeFileSync(path.join(egressDir, output_ref.split("/").pop() + ".out"), text, { mode: 0o600 }); },
      });
      return out({ id, ok: true, result: { ready: true } });
    }
    if (!engine) throw new SealError("not_init", "not started");
    const fn = /** @type {any} */ (engine)[op];
    if (op === "stats") return out({ id, ok: true, result: engine.stats() });
    if (!Object.hasOwn(engine, op) || typeof fn !== "function") throw new SealError("bad_request", "unknown operation");
    out({ id, ok: true, result: fn(args, ticket) });
  } catch (e) {
    const code = e instanceof SealError ? e.code : "failed";
    out({ id, ok: false, error: { code, message: e instanceof SealError ? e.message : "the sealing process could not do that" } });
  }
});
rl.on("close", () => process.exit(0));
