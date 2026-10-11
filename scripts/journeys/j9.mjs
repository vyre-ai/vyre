// J9 Team day (team/0.3.3, the minimum for the release): on a real server, three people with their own logins work in one Space for a day. Each person's chats run on their own Mac where the Space allows it; one
// shared chat where each person's message uses their own AI; one person hands a session to the server and carries on from the phone; a project starts from a template with a Flow; Records fill in.
// A development-build box installed by the real installer (the yes comes from each app's own presence key). Pieces that do not exist yet FAIL by name with the team that owns them (never a skip), so
// the line turns green by itself when the piece lands. Proof (the transcript) is written to <out>/j9/ and copied to team/0.3.3/proof/team-day/ by whoever signs it off.
//   VYRE_JOURNEY_BOX=1 node scripts/journeys/run.mjs J9      (a throwaway test box or a CI runner; see scripts/proof-dev-droplet.mjs --journeys J9)
import assert from "node:assert/strict";
import path from "node:path";
import { createApp } from "../lib/proof/app.mjs";
import { bringUp } from "./lib/world.mjs";
import { stepper } from "./lib/journey.mjs";
import { whenStoreIsUp } from "./lib/store.mjs";
import { sharedChatSteps } from "./lib/shared-chat.mjs";

const NAMES = ["Ada Lovelace", "Grace Hopper", "Edith Clarke"];
/** A piece that is not built: the step fails by name, owner included. @param {string} what @param {string} owner */
const missing = (what, owner) => () => { throw new Error(`NOT BUILT YET: ${what} (owner: ${owner})`); };

export default {
  id: "J9", title: "Team day", owner: "release", world: "own", store: "records", optIn: true,
  /** @param {any} ctx @param {ReturnType<typeof stepper>} J */
  async steps(ctx, J) {
    // J9_PARTS=chat walks only the team, the members' sign-ins and the shared chat, on the plain store (no Twenty to wait for): the quick loop while that part is built. The journey as the release runs it is all of it.
    const only = process.env.J9_PARTS === "chat";
    const heavy = (/** @type {any[]} */ ...a) => (only ? undefined : /** @type {any} */ (J.step)(...a));
    const w = await bringUp({ run: ctx.run, out: path.join(ctx.out, "j9"), kind: "box", store: only ? "plain" : "records", devBuild: true, recreate: false });
    if (!w.ready) { await J.step("the world is up", () => { throw new Error("the dev-build box world did not come up; see the lines above (owner: release)"); }); return; }
    const { mac, srv, ins } = w;
    mac.setYes(srv.yesFor(mac.identity.id, mac.presenceSigner));
    /** @type {any} */ let team = null;
    const people = /** @type {{ name: string, app: any, invite?: any, joined?: any }[]} */ ([]);
    const chainOf = (/** @type {string} */ space, /** @type {string} */ person) => ({ space, hops: [{ actor: { kind: "person", id: person, space } }] });
    try {
      const T = "the owner makes the team in the server's own Space (one Space per server: no second Space is made)";
      await J.step(T, async () => {
        const rowsOf = async () => { const ls = await w.call("spaces.list", {}); return Array.isArray(ls) ? ls : ls.spaces || []; };
        const before = await rowsOf();
        team = await mac.createTeamSpace(`day${w.person.slice(-5)}`);
        assert.match(team.space, /^spc_/);
        const r = await fetch(`${ins.names}/v1/ids/resolve?name=${team.label}`);
        assert.equal(r.status, 200, "the names directory resolves the Space's name");
        const after = await rowsOf();
        assert.equal(after.length, before.length, `no second Space appeared: ${JSON.stringify(after).slice(0, 300)}`);
        assert.ok(after.some((/** @type {any} */ x) => (x.id || x.space) === team.space && x.label === team.label), "the server's own Space is listed under the team's name");
        return team.name;
      }, { owner: "projects-flows" });

      // the owner of the team server presses "Set up My Cloud" (its hosting call: spaces.create ends in spaces.host-here on the server): a second Space on a server whose Space is the team's is refused, in words
      await J.step("Set up My Cloud on the team's server is refused: this server's Space is already the team's", async () => {
        const before = (() => w.call("spaces.list", {}))();
        const rows0 = await before;
        const n0 = (Array.isArray(rows0) ? rows0 : rows0.spaces || []).length;
        let err = /** @type {any} */ (null);
        try { await mac.callTool("spaces.host-here", { name: `mycloud${w.person.slice(-4)}` }); } catch (e) { err = e; }
        assert.ok(err, "the second Space was refused");
        assert.equal(err.code, "server_has_team", String(err && err.message));
        assert.match(String(err.message), /Connect another server for My Cloud/);
        const rows1 = await w.call("spaces.list", {});
        assert.equal((Array.isArray(rows1) ? rows1 : rows1.spaces || []).length, n0, "nothing was made");
        return String(err.message);
      }, { owner: "projects-flows" });

      // two more people, each with their own app, name and keys
      const SIGN = "two more people sign in with their own logins and are members";
      await J.step(SIGN, async () => {
        for (const who of ["Grace", "Edith"]) {
          const app = createApp({ label: `Team day ${who}`, dir: path.join(w.dir, who.toLowerCase()), directory: ins.names, relay: ins.relay });
          const r = await app.reserve(`${who.toLowerCase()}${Math.random().toString(36).slice(2, 6)}`);
          await app.becomeYourself({ name: r.name, code: r.code });
          const owner = chainOf(team.space, mac.identity.id);
          const invite = await mac.makeTeamInvite({ space: team.space, name: team.label, to: r.name, signPresence: async (/** @type {any} */ card) => (srv.team ? srv.team.ownerSigner : mac.presenceSigner).proof(owner, card.op, card.fields, { extra: { home: card.home, challenge: card.challenge } }) });
          invite.close();
          const sg = app.presenceSigner, chain = chainOf(team.space, app.identity.id);
          const joined = await app.joinTeam({ link: invite.link, signPresence: async (/** @type {any} */ req) => sg.proof(chain, req.op, req.fields), presenceKey: async () => sg.enrolment(app.identity.id) });
          assert.equal(joined.joined.joined, true, `${who} joined`);
          people.push({ name: who, app, invite, joined });
        }
        // a member's door shows the member their own row (not the others): each reads theirs and finds the role. The owner's own list needs an identity the box does not hold; see the finding below.
        for (const p of people) {
          const list = await p.joined.call("grants.members.list", []);
          const rows = Array.isArray(list) ? list : list.members || [];
          const mine = rows.find((/** @type {any} */ m) => (m.person || m.id) === p.app.identity.id);
          assert.ok(mine && mine.role === "member", `${p.name} is a member; their list holds ${JSON.stringify(rows).slice(0, 300)}`);
        }
        return `${people.length + 1} people`;
      }, { needs: [T], owner: "trust" });

      // Records filling in: the owner enters clients, both members read the same list
      const R = "Records fill in: the owner adds clients and every member reads the same list";
      await heavy(R, async () => {
        const made = [];
        for (const name of NAMES) {
          const c = await whenStoreIsUp(w, "records.create", { type: "contact", data: { name } });
          const cl = await whenStoreIsUp(w, "records.create", { type: "client", data: { contact: { urn: c.record.urn } } });
          made.push(cl.record.urn);
        }
        for (const p of people) {
          const theirs = await p.joined.call("records.query", ["client", { page: { limit: 50 } }]);
          assert.deepEqual((theirs.rows || []).map((/** @type {any} */ r) => r.urn).sort(), made.sort(), `${p.name} sees the owner's client list`);
        }
        return `${made.length} clients, read by ${people.length} members`;
      }, { needs: [SIGN], owner: "projects-flows" });

      // a project from a template, with its Flow
      const P = "a project starts from a template and its stages and tasks are made";
      /** @type {any} */ let project = null;
      await heavy(P, async () => {
        const lib = await whenStoreIsUp(w, "work.template.library", {});
        const first = (lib.templates || [])[0];
        assert.ok(first, "the library offers a template");
        // the library template's first tasks are done by the assistant "research", which a new Space lacks (start-project would make the project with no tasks); every app walk makes it before the install
        await whenStoreIsUp(w, "agents.create", { name: "research", kind: "agent", projects: [], instructions: "Finds and reads the documents." });
        const inst = await whenStoreIsUp(w, "work.template.install", { id: first.id });
        const tpl = inst.template || first.id;
        // an installed template is a draft; the app's Templates screen has Go live as its own action and every app walk calls it (work.template.golive puts the draft version live)
        await whenStoreIsUp(w, "work.template.golive", { template: tpl, version: inst.version });
        const started = await whenStoreIsUp(w, "work.start-project", { template: tpl, name: `Team day ${w.person.slice(-4)}` });
        assert.ok(started.project, "a project was made");
        assert.ok((started.tasks_made || 0) > 0, `tasks were made (${JSON.stringify(started.tasks_skipped || [])})`);
        project = started;
        return `${first.name}: ${started.tasks_made} tasks`;
      }, { needs: [T], owner: "projects-flows" });
      await heavy("the project's timeline begins with where it started from", async () => {
        const tl = await w.call("work.timeline", { project: project.slug || project.project });
        assert.match(JSON.stringify(tl), /Started from/i);
      }, { needs: [P], owner: "projects-flows" });
      await heavy("a Flow from the template is installed, healthy, and has run", async () => {
        const list = await w.call("flows.list", {});
        const flows = Array.isArray(list) ? list : list.flows || [];
        assert.ok(flows.length > 0, "the template's Flow is installed");
        const h = await w.call("flows.health", {});
        assert.ok(h, "the Flows health answers");
        throw new Error("NOT PROVEN YET: a template Flow RUN on this box (name the stage move or task that fires it, then assert its run on the timeline) (owner: projects-flows)");
      }, { needs: [P], owner: "projects-flows" });

      // the pieces that are not built: each fails by name until its owner lands it, then must be filled in with the real calls
      /** @type {number[]} how long each member's first chat took, in ms */ const firstChatMs = [];
      await heavy("each member has their own session on the server and sees their own Chats", async () => {
        const made = [];
        for (const p of people) {
          // up to 120 s so the walk goes on, and the time is kept: a person's app waits 30 s (the next step says so)
          const t0 = Date.now();
          const c = await p.joined.call("chat.create", [{ title: `${p.name}'s notes` }], { timeoutMs: 120_000 });
          firstChatMs.push(Date.now() - t0);
          assert.match(String(c.chat), /^chat_/, `${p.name} starts their own chat on the server`);
          made.push(c.chat);
        }
        for (const [n, p] of people.entries()) {
          const list = (await p.joined.call("chat.list", [{}])).chats || [];
          assert.ok(list.some((/** @type {any} */ x) => x.chat === made[n] && x.open === true), `${p.name} sees their own chat`);
          assert.ok(!list.some((/** @type {any} */ x) => x.chat === made[1 - n] && x.open === true), `${p.name} is not in the other member's chat`);
        }
        return `${people.length} members, each in their own chat (first chat took ${firstChatMs.map(ms => (ms / 1000).toFixed(1)).join(" s and ")} s)`;
      }, { needs: [SIGN], owner: "chat" });
      const MS = "each member's FIRST chat in the team Space answers within the 30 s a person's app waits";
      await J.step(MS, async () => {
        assert.ok(firstChatMs.length > 0, "the chats above were not made");
        const slow = firstChatMs.filter(ms => ms > 30_000);
        assert.equal(slow.length, 0, `the first chat took ${(Math.max(...firstChatMs) / 1000).toFixed(1)} s (all: ${firstChatMs.map(ms => (ms / 1000).toFixed(1)).join(", ")} s): in the app a first chat in a new team Space times out and works on the second try (owner: chat)`);
        return `first chats took ${firstChatMs.map(ms => (ms / 1000).toFixed(1)).join(", ")} s`;
      }, { needs: [SIGN], owner: "chat" });
      await heavy("each person's chats run on their own Mac where the Space allows it, and the chat says so", missing("three lent computers (one per person) and a chat placed on each person's own", "link"), { needs: [SIGN], owner: "link" });
      await sharedChatSteps({ J, w, team, people, needs: [SIGN] });
      await heavy("one person hands a session to the server and continues from the phone", missing("a session hand-off to the server and a phone (second device of the same person) that continues it", "chat"), { needs: [SIGN], owner: "chat" });
    } finally {
      // J9_KEEP=<minutes>: leave the box up that long after the steps, to look inside it (docker exec -u vyre vyre-vyre-1 ...)
      if (process.env.J9_KEEP) await new Promise(r => setTimeout(r, Number(process.env.J9_KEEP) * 60_000));
      for (const p of people) { try { p.app.close(); } catch { /* closed */ } }
      await w.stop().catch(() => {});
    }
  },
};
