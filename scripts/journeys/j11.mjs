// J11 Member day (team/0.3.3, rc.3): what a MEMBER sees and does on a real paired team server: the owner, an admin and two members. A member answers the question her own turn raised and stops her own turn; the
// other member who knows the question's id, and an outsider, are refused; the owner and the admin stop a member's turn; the held message says whose question it waits on; Teammates, the project story and Sites show a
// member only her projects. A development-build box installed by the real installer; the AI is the repo's stand-in agent (see lib/member-day.mjs). Proof (the transcript) is written to <out>/j11/.
//   VYRE_JOURNEY_BOX=1 node scripts/journeys/run.mjs J11
import assert from "node:assert/strict";
import path from "node:path";
import { bringUp } from "./lib/world.mjs";
import { memberDaySteps } from "./lib/member-day.mjs";

export default {
  id: "J11", title: "Member day", owner: "release", world: "own", store: "records", optIn: true,
  /** @param {any} ctx @param {any} J */
  async steps(ctx, J) {
    const w = await bringUp({ run: ctx.run, out: path.join(ctx.out, "j11"), kind: "box", store: "records", devBuild: true, recreate: false });
    if (!w.ready) { await J.step("the world is up", () => { throw new Error("the dev-build box world did not come up; see the lines above (owner: release)"); }); return; }
    const { mac, srv, ins } = w;
    mac.setYes(srv.yesFor(mac.identity.id, mac.presenceSigner));
    try {
      const T = "the owner makes the team Space on the server";
      /** @type {any} */ let team = null;
      await J.step(T, async () => {
        team = await mac.createTeamSpace(`mday${w.person.slice(-5)}`);
        assert.match(team.space, /^spc_/);
        const r = await fetch(`${ins.names}/v1/ids/resolve?name=${team.label}`);
        assert.equal(r.status, 200, "the names directory resolves the Space's name");
        return team.name;
      }, { owner: "projects-flows" });
      await memberDaySteps({ J, w, team, needs: [T] });
    } finally {
      if (process.env.J11_KEEP) await new Promise(r => setTimeout(r, Number(process.env.J11_KEEP) * 60_000));
      await w.stop().catch(() => {});
    }
  },
};
