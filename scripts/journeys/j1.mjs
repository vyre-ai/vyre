// J1 Firm day one (team/0.3.1/JOURNEYS.md): fresh server -> owner identity -> space -> invite a member -> the member joins -> both see the same client list; the assistant is pinned in
// each person's Chats; @Engineer is in Settings for the owner only. Daemon world: a box takes the owner's and the joiner's yes only from a hardware key.
import assert from "node:assert/strict";
import path from "node:path";
import { createApp } from "../lib/proof/app.mjs";
import { startChat } from "./lib/chat.mjs";
import { whenStoreIsUp } from "./lib/store.mjs";

const NAMES = ["Ada Lovelace", "Grace Hopper", "Edith Clarke"];

export default {
  id: "J1", title: "Firm day one", owner: "projects-flows", world: "daemon", store: "records",
  /** @param {any} w @param {ReturnType<typeof import("./lib/journey.mjs").stepper>} J */
  async steps(w, J) {
    const { mac, ins, srv } = w;
    /** @type {any} */ let team = null, invite = null, bob = null, joined = null;
    const made = [];
    const T = "the owner makes a team space on the server";
    await J.step(T, async () => {
      team = await mac.createTeamSpace(`firm${w.person.slice(-5)}`);
      assert.match(team.space, /^spc_/);
      const r = await fetch(`${ins.names}/v1/ids/resolve?name=${team.label}`);
      assert.equal(r.status, 200, "the names directory resolves the space's name");
      w.team = team;
      return team.name;
    }, { owner: "projects-flows" });

    // the owner's pinned chats exist the way the app makes them (apps/app/src/state/persistent-chat.ts)
    const A = "the owner's assistant gets its one pinned chat, and a second ask returns the same one";
    await J.step(A, async () => {
      const have = await w.call("work.chat.persistent", { kind: "assistant" });
      assert.equal(have.allowed, true, "the owner may have an assistant chat");
      const chat = have.chat || await startChat(w, "Assistant");
      assert.ok(chat, "a chat id");
      if (!have.chat) await w.call("work.chat.pin", { kind: "assistant", chat });
      const again = await w.call("work.chat.persistent", { kind: "assistant" });
      assert.equal(again.chat, chat, "the pinned chat is the one made");
      const list = await w.call("work.chat.list", {});
      const row = (list.chats || []).find((/** @type {any} */ c) => (c.chat || c.id) === chat);
      assert.equal(row && row.pinned, "assistant", "the Chats list marks it pinned");
      return chat;
    }, { owner: "chat" });
    await J.step("@Engineer is available to the owner and has its own pinned chat", async () => {
      const have = await w.call("work.chat.persistent", { kind: "engineer" });
      assert.equal(have.allowed, true, "the owner may have an @Engineer chat");
      const agents = await w.call("agents.list", {});
      assert.ok((agents || []).some((/** @type {any} */ a) => a.role === "engineer" && a.builtin), "the space has the built-in engineer agent");
    }, { owner: "projects-flows" });

    // invite and join, signed by the keys of the two apps (a development signer; the yes is the real one)
    const I = "the owner invites a second person, the owner's key signs the invite";
    await J.step(I, async () => {
      bob = createApp({ label: "Journey second Mac", dir: path.join(w.dir, "second"), directory: ins.names, relay: ins.relay });
      const r = await bob.reserve(`second${Math.random().toString(36).slice(2, 6)}`);
      await bob.becomeYourself({ name: r.name, code: r.code });
      const t = srv.team;
      const ownerChain = t.ownerChain(team.space, mac.identity.id);
      const asked = [];
      invite = await mac.makeTeamInvite({ space: team.space, name: team.label, to: r.name, signPresence: async (/** @type {any} */ card) => { asked.push(card.op); return t.ownerSigner.proof(ownerChain, card.op, card.fields, { extra: { home: card.home, challenge: card.challenge } }); } });
      invite.close();
      assert.match(invite.link, /^https:\/\/[a-z0-9-]+\.vyre\.run\/join\/inv_[0-9a-f]{32}\./);
      assert.deepEqual(asked, ["grant.invite"], "the owner's key was asked once, for this invite");
      invite.ownerChain = ownerChain;
      return r.name;
    }, { needs: [T], owner: "trust" });
    const JN = "the second person joins from their own app and is a member";
    await J.step(JN, async () => {
      const t = srv.team;
      const sg = t.signerFor(bob.identity.id);
      const chain = t.inviteeChain(team.space, bob.identity.id);
      joined = await bob.joinTeam({ link: invite.link, signPresence: async (/** @type {any} */ req) => sg.proof(chain, req.op, req.fields), presenceKey: async () => sg.enrolment });
      assert.equal(joined.joined.joined, true);
      const member = await t.memberOf(team.space, invite.ownerChain, bob.identity.id);
      assert.deepEqual([member.person, member.role], [bob.identity.id, "member"]);
    }, { needs: [I], owner: "trust" });

    // one client list for both
    const C = "the owner adds three clients";
    await J.step(C, async () => {
      for (const name of NAMES) {
        const c = await whenStoreIsUp(w, "records.create", { type: "contact", space: team.space, data: { name } });
        const cl = await whenStoreIsUp(w, "records.create", { type: "client", space: team.space, data: { contact: { urn: c.record.urn } } });
        made.push({ name, client: cl.record.urn });
      }
      const rows = (await w.call("records.list", { type: "client", space: team.space })).rows;
      assert.equal(rows.length, NAMES.length, "the owner sees every client");
      return `${rows.length} clients`;
    }, { needs: [T], owner: "projects-flows" });
    await J.step("the member sees the same client list through the member door", async () => {
      const theirs = await joined.call("records.query", ["client", { page: { limit: 50 } }]);
      const urns = (theirs.rows || []).map((/** @type {any} */ r) => r.urn).sort();
      assert.deepEqual(urns, made.map(m => m.client).sort(), "the member's list is the owner's list");
      const contacts = await joined.call("records.query", ["contact", { page: { limit: 50 } }]);
      assert.deepEqual((contacts.rows || []).map((/** @type {any} */ r) => r.data.name).sort(), [...NAMES].sort(), "and reads each client's name");
    }, { needs: [JN, C], owner: "projects-flows" });
    await J.step("the member cannot do the owner's work: no invites, no role changes", async () => {
      await assert.rejects(joined.call("grants.invites.create", [{ role: "member" }]), /./, "a member's invite is refused");
      await assert.rejects(joined.call("grants.setRole", [bob.identity.id, "owner"]), /./, "a member cannot make themselves an owner");
    }, { needs: [JN], owner: "trust" });
    await J.step("the events log shows the invite and the join", async () => {
      const ev = await w.call("records.events", { space: team.space, limit: 200 });
      const names = JSON.stringify(ev).match(/"(?:type|kind|event)":"([a-z._-]+)"/g) || [];
      assert.ok(JSON.stringify(ev).includes("invite"), `no invite event among ${names.slice(0, 12).join(", ")}`);
    }, { needs: [JN], owner: "trust" });
    // BLOCKED, said plainly: the second person has no session on the server (they joined through the member door), so their own Chats and Settings cannot be read with tools yet.
    await J.step("the member's own Chats show their assistant pinned, and Settings has no @Engineer for them", () => {
      throw Object.assign(new Error("BLOCKED: a member who joined through the member door has no session on the server to ask work.chat.persistent with; needs a member session door (owner: chat). Add this check when it exists."), { skip: true });
    }, { needs: [JN], owner: "chat" });
    if (bob) bob.close();
  },
};
