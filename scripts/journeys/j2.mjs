// J2 Intake to signed engagement (team/0.3.1/JOURNEYS.md): a client record -> a project from the Estate template -> the intake stage done -> the stage move runs the signing Flow -> Documents fills the
// engagement letter from the record -> PDF -> Comms holds the email at the Gate -> ONE yes -> the signer opens the page as a stranger -> signed -> the signed copy is filed on the client -> the record
// moves to the signed stage -> the timeline says each step in plain lines -> exactly one email went out.
import assert from "node:assert/strict";

export default {
  id: "J2", title: "Intake to signed engagement", owner: "operations", world: "daemon", store: "plain",
  /** @param {any} w @param {ReturnType<typeof import("./lib/journey.mjs").stepper>} J */
  async steps(w, J) {
    /** @type {any} */ let team = null;
    await J.step("the owner makes a team space on the server", async () => {
      team = await w.mac.createTeamSpace(`firm${w.person.slice(-5)}`);
      assert.match(team.space, /^spc_/);
      return team.name;
    });
    const sp = () => team.space;
    await J.step("explore: a client and its contact", async () => {
      const c = await w.call("records.create", { type: "contact", space: sp(), data: { name: "Dana Harlow", email: "dana@harlow.test" } });
      let cl;
      try { cl = await w.call("records.create", { type: "client", space: sp(), data: { contact: c.record.urn } }); } catch (e) { throw new Error(`${e.message} | urn ${c.record.urn} | space ${sp()} | tries id: ${await w.call("records.create", { type: "client", space: sp(), data: { contact: c.record.id } }).then(() => "ok", x => x.message)}`); }
      const got = await w.call("records.get", { type: "client", space: sp(), id: cl.record.id });
      return JSON.stringify({ c: c.record, cl: cl.record, got });
    });
  },
};
