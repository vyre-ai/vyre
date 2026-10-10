// @ts-check
// Fixtures for contracts/runner.md (team/contracts/runner.md). A consumer builds against these while link builds the real thing: design draws the chip, the moved line, Settings, This computer and the Lumen
// list from them. Every value here is checked against the real tools and events by test/contracts/runner.test.js, so a fixture that drifts from the producer fails there.
export { shapeDiff } from "./operator-cards.fixtures.js";

export const CHAT = "chat_01a12319-bf9c-4ec9-ab1b-9dd9f04df6dc";
export const SESSION = "s_contract_1";

export const REASONS = ["lid-closed", "asleep", "unplugged", "cpu-cap", "mem-cap", "switched-off", "offline", "lease-expired", "crash", "version-skew", "you"];
export const STATES = ["here", "moving", "server", "locked", "updating", "paused"];

export const runnerFixtures = {
  /** What `runner.placement` answers in each situation a chip has to draw. */
  placements: {
    onTheComputer: { where: "mac", computer: "Office Mac", state: "here", reason: null, since: 1_760_000_000_000, offer: null, pinned: false, pin: null, epoch: 1 },
    handingOver: { where: "mac", computer: "Office Mac", state: "moving", reason: null, since: 1_760_000_000_000, offer: null, pinned: false, pin: null, epoch: 1 },
    movedByCondition: { where: "server", computer: null, state: "server", reason: "lid-closed", since: 1_760_000_100_000, offer: null, pinned: false, pin: null, epoch: 2 },
    offeredBack: { where: "server", computer: null, state: "server", reason: "lid-closed", since: 1_760_000_100_000, offer: "mac", pinned: false, pin: null, epoch: 2 },
    theServersOwn: { where: "server", computer: null, state: "server", reason: null, since: null, offer: null, pinned: false, pin: null },
  },
  /** `runner.move`, `runner.why-not`. */
  calls: {
    move: { input: { thread: CHAT, to: "server" }, output: { where: "mac", computer: "Office Mac", state: "moving", reason: null, since: 1_760_000_000_000, offer: null, pinned: false, pin: null, epoch: 1 } },
    whyNot: { input: { thread: CHAT }, output: { reason: "lid-closed" } },
    settings: { input: {}, output: { enabled: false, pluggedInOnly: true, cpuPercent: 50, memoryMb: 4096 } },
    settingsSet: { input: { enabled: true, cpuPercent: 40 }, output: { enabled: true, pluggedInOnly: true, cpuPercent: 40, memoryMb: 4096 } },
    here: { input: {}, output: { sessions: [{ thread: CHAT, title: "A session", computer: "Office Mac", state: "running", cpuPercent: 12, memoryMb: 340, line: "Running, 12% processor, 340 MB", cpu: "12%" }] } },
    pauseAll: { input: {}, output: { paused: 1 } },
    resumeAll: { input: {}, output: { resumed: 1 } },
  },
  /** The payload on the chat's stream when a session changes place. */
  events: {
    "thread.moved": { thread: CHAT, session: SESSION, from: "mac", to: "server", reason: "lid-closed", epoch: 2, device: "dev_office_mac", at: 1_760_000_100_000 },
  },
  /** The wire between a computer and its server, for the producers of the transports (Wink, the relay), not for screens. */
  wire: {
    beatAnswer: { ok: true, fenced: [], offers: [], directives: [{ do: "release", session: SESSION, chat: CHAT, reason: "you" }] },
    releaseAnswer: { moved: true, epoch: 2 },
  },
  limits: { cpuPercent: [10, 100], memoryMb: [512, 65536], heartbeatMs: 5000, lapseMs: 20_000, cooldownMs: 120_000, askMs: 60_000 },
  defaults: { enabled: false, pluggedInOnly: true, cpuPercent: 50, memoryMb: 4096 },
};
