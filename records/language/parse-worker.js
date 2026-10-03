// @ts-check
import { parentPort, workerData } from "node:worker_threads";
import { parse } from "./parse.js";
try {
  parentPort?.postMessage({ ok: true, program: parse(workerData.source, workerData.limits) });
} catch (e) {
  const err = /** @type {any} */ (e);
  parentPort?.postMessage({ ok: false, code: err.code || "syntax", message: String(err.message), line: err.line, col: err.col });
}
