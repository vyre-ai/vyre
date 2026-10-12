// J6 Flows that run themselves (team/0.3.1/JOURNEYS.md): the Flow part is projects-flows' real-daemon test (test/journey-flows.test.js).
import { walkTestFile } from "./lib/testfile.mjs";

export default {
  id: "J6", title: "Flows that run themselves", owner: "projects-flows", world: "own", store: "plain",
  /** @param {any} _w @param {ReturnType<typeof import("./lib/journey.mjs").stepper>} J */
  async steps(_w, J) {
    // the Flow on the plain store (the file's own home; the world's store settings do not reach it: lib/testfile.mjs journeyEnv), then the same Flow on the real Twenty store once the Space's types are defined
    await walkTestFile(J, "test/journey-flows.test.js", "projects-flows").report();
    await walkTestFile(J, "test/journey-flows.test.js", "projects-flows", { env: { VYRE_STORE: "auto" }, label: "on Twenty", timeoutMs: 50 * 60_000 }).report();
  },
};
