// J12 Door gate (team/0.3.3, rc.3): the door gate (work/rc3/door-gate) on a real paired team server: a member's session is refused in words on the owner's tools and served on her own, the owner is unaffected,
// pairing and sign-in work. A development-build box installed by the real installer; the AI is the repo's stand-in agent. Run against any tree that carries the gate:
//   VYRE_JOURNEY_BOX=1 node scripts/journeys/run.mjs J12
import assert from "node:assert/strict";
import path from "node:path";
import { bringUp } from "./lib/world.mjs";
import { doorGateSteps } from "./lib/door-gate.mjs";

export default {
  id: "J12", title: "Door gate", owner: "release", world: "own", store: "records", optIn: true,
  /** @param {any} ctx @param {any} J */
  async steps(ctx, J) {
    const w = await bringUp({ run: ctx.run, out: path.join(ctx.out, "j12"), kind: "box", store: "records", devBuild: true, recreate: false });
    if (!w.ready) { await J.step("the world is up", () => { throw new Error("the dev-build box world did not come up; see the lines above (owner: release)"); }); return; }
    const { mac, srv, ins } = w;
    mac.setYes(srv.yesFor(mac.identity.id, mac.presenceSigner));
    try {
      const T = "the owner makes the team Space on the server";
      /** @type {any} */ let team = null;
      await J.step(T, async () => {
        team = await mac.createTeamSpace(`gate${w.person.slice(-5)}`);
        assert.match(team.space, /^spc_/);
        const r = await fetch(`${ins.names}/v1/ids/resolve?name=${team.label}`);
        assert.equal(r.status, 200);
        return team.name;
      }, { owner: "projects-flows" });
      await doorGateSteps({ J, w, team, needs: [T] });
    } finally {
      if (process.env.J12_KEEP) await new Promise(r => setTimeout(r, Number(process.env.J12_KEEP) * 60_000));
      await w.stop().catch(() => {});
    }
  },
};
