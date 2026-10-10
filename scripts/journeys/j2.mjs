// J2 Intake to signed engagement (team/0.3.1/JOURNEYS.md): a client record -> a project from the Estate template -> the intake stage done -> the stage move runs the signing Flow -> Documents fills the
// engagement letter from the record -> PDF -> Comms holds the email at the Gate -> ONE yes -> the signer opens the page as a stranger -> signed -> the signed copy is filed on the client -> the record
// moves to the signed stage -> the timeline says each step in plain lines -> exactly one email went out.
import assert from "node:assert/strict";

export default {
  id: "J2", title: "Intake to signed engagement", owner: "operations", world: "daemon", store: "plain",
  /** @param {any} w @param {ReturnType<typeof import("./lib/journey.mjs").stepper>} J */
  async steps(w, J) {
    await J.step("explore: the record types and tools this server has", async () => {
      const types = await w.call("records.types", {});
      return JSON.stringify(types).slice(0, 600);
    });
  },
};
