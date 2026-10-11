// J4 Agent builds and shares (team/0.3.1/JOURNEYS.md): an agent starts a React dashboard, a preview card opens in the pane, its data survives a reload and a restart, it is shared to the project, and one
// tap publishes it. Publish's part is trust's real-daemon test (test/journey-publish-react.test.js); the preview and the pane are chat's, still to walk here.
import { walkTestFile } from "./lib/testfile.mjs";

export default {
  id: "J4", title: "Agent builds and shares", owner: "trust", world: "own", store: "plain",
  /** @param {any} _w @param {ReturnType<typeof import("./lib/journey.mjs").stepper>} J */
  async steps(_w, J) { await walkTestFile(J, "test/journey-publish-react.test.js", "trust").report(); },
};
