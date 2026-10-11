// J3 Secrets done right (team/0.3.1/JOURNEYS.md): a key pasted in chat is held as a card -> yes -> it is in the Vault, the chat shows the chip -> a Connection uses it by reference -> the model never
// saw it (scan) -> an agent fills a website login without seeing it -> Vault health shows in Now as one row.
// The Vault's part is trust's real-daemon test (test/journey-secrets.test.js); the paste card in chat and the agent's website sign-in are the parts still to walk here.
import { walkTestFile } from "./lib/testfile.mjs";

export default {
  id: "J3", title: "Secrets done right", owner: "trust", world: "own", store: "plain",
  /** @param {any} _w @param {ReturnType<typeof import("./lib/journey.mjs").stepper>} J */
  async steps(_w, J) { await walkTestFile(J, "test/journey-secrets.test.js", "trust").report(); },
};
