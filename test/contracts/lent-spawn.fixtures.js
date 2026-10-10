// @ts-check
// Fixtures for contracts/lent-spawn.md (team/contracts/lent-spawn.md). chat builds the lent spawn against these while link builds the real thing; every value is checked against the real home, the real wire and the real
// pump by test/contracts/lent-spawn.test.js, so a fixture that drifts from the producer fails there.
export { shapeDiff } from "./operator-cards.fixtures.js";

export const SESSION = "s_spawn_contract_1";
export const b64 = (/** @type {string} */ s) => Buffer.from(s).toString("base64");

export const lentSpawnFixtures = {
  /** The SDK's arguments as the SDK gives them, and what the lender is sent: nothing that names a file, socket or folder on the box, and not the interpreter's script. */
  args: { given: ["/box/lib/claude/cli.js", "--output-format", "stream-json", "--verbose", "--mcp-config", "/box/run/mcp.json", "--permission-mode", "default"], sent: ["--output-format", "stream-json", "--verbose", "--permission-mode", "default"] },
  /** The heartbeat's answer carries this when a chat was spawned for the lender, and `lent.start` answers a definition with these keys set. */
  directive: { do: "start", session: SESSION, pipe: true },
  startDefinition: { command: "claude", env: {}, pipe: true },
  /** `lent.pipe`: the lender's request and the home's answer. */
  call: { session: SESSION, epoch: 1, up: [{ seq: 1, stream: "out", b64: b64("{\"type\":\"system\"}\n") }], ack: 0, wait_ms: 20_000 },
  answer: { down: [{ seq: 1, b64: b64("{\"type\":\"user\"}\n") }], acked: 1 },
  /** `end` and `kill` ride every answer after they are first told, until the process ends (the first answer to carry one returns at once; later ones do not make a call return early). */
  answerKill: { down: [], acked: 1, end: true, kill: "SIGTERM" },
  answerEnd: { down: [], acked: 1, end: true },
  answerClosed: { down: [], acked: 1, closed: true },
  answerHold: { down: [], acked: 1, hold_ms: 1000 },
  answerIdle: { down: [], acked: 0, idle: true },
  /** The exit the lender sends once every chunk before it is acked. */
  exit: { code: 0, signal: null },
  /** Numbers the contract promises. */
  limits: { chunkBytes: 32 * 1024, callBytes: 128 * 1024, callChunks: 16, downHigh: 1024 * 1024, upHigh: 4 * 1024 * 1024, holdMs: 1000, waitMs: 20_000, waitMaxMs: 25_000, startMs: 15_000, killMs: 5000 },
  /** What the SDK may use of the object `lent.spawn` returns. */
  processKeys: ["stdin", "stdout", "stderr", "pid", "killed", "exitCode", "signalCode", "kill", "on", "once", "emit", "moved", "lent"],
  /** Why a spawn failed before anything ran, and what a move under a running chat leaves behind. */
  neverStarted: { errorCode: "lent_unavailable", exitCode: null, signalCode: null },
  moved: { signal: "SIGHUP", moved: { to: "server", reason: "lid-closed", epoch: 2 } },
};
