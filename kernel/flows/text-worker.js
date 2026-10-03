// Runs parseFlowText in a worker thread with a memory ceiling (text.js parseFlowTextBounded).
import { parentPort, workerData } from "node:worker_threads";
import { parseFlowText } from "./text.js";

try {
  parentPort?.postMessage({ ok: parseFlowText(workerData.text) });
} catch (e) {
  const x = /** @type {any} */ (e);
  parentPort?.postMessage({ error: { message: x && x.message, detail: x && x.detail, line: x && x.line, col: x && x.col } });
}
