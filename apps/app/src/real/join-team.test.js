// @ts-check
// The pure parts of joining a team from a device that holds a name (src/real/join-team.js): which links are join links, what the invite pins, and that install.ts joins from this app when it holds the name.
// The whole join, against a real server, is test/wink-paired-2.test.js "join a team with no server".
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseInviteLink, spaceFingerprint } from "./join-team.js";

const PIN = { id: "spc_" + "a".repeat(26), seq: 3, head: "b".repeat(64) };
const token = (o = {}) => `inv_${"0".repeat(32)}.${Buffer.from(JSON.stringify({ chain: PIN, rk: "c".repeat(32), ...o })).toString("base64url")}`;

test("a join link is https, <label>.vyre.run, /join/<token>, with the version of the space's list it was made for; anything else is refused in words", () => {
  const p = parseInviteLink(`https://Harlow.vyre.run/join/${token()}`);
  assert.deepEqual([p.name, p.host, p.invite, p.pin, p.rk], ["harlow", "harlow.vyre.run", "inv_" + "0".repeat(32), PIN, "c".repeat(32)]);
  for (const [link, code, say] of [
    ["not a link", "bad_input", /not a link/],
    [`http://harlow.vyre.run/join/${token()}`, "bad_input", /https/],
    [`https://harlow.example.com/join/${token()}`, "bad_input", /not a Vyre space/],
    [`https://harlow.vyre.run:8443/join/${token()}`, "bad_input", /not a join link/],
    [`https://harlow.vyre.run/join/${token()}?x=1`, "bad_input", /not a join link/],
    [`https://user:pw@harlow.vyre.run/join/${token()}`, "bad_input", /not a join link/],
    ["https://harlow.vyre.run/join/abc.def", "bad_input", /not a join link/],
    [`https://harlow.vyre.run/join/inv_${"0".repeat(32)}.${Buffer.from("{}").toString("base64url")}`, "unpinned", /which version/],
  ]) assert.throws(() => parseInviteLink(link), e => e.code === code && say.test(e.message), link);
});

test("the fingerprint is the one the inviter's space shows: sha-256 of the tag, the permanent id and the root key, 32 hex characters", () => {
  assert.match(spaceFingerprint("spc_x", "KEY"), /^[0-9a-f]{32}$/);
  assert.notEqual(spaceFingerprint("spc_x", "KEY"), spaceFingerprint("spc_x", "KEZ"));
});

test("install.ts joins and reads an invite through the onboard tools, the same ones every client calls; the app's own side is in team-join.ts", () => {
  const install = fs.readFileSync(new URL("./install.ts", import.meta.url), "utf8");
  assert.match(install, /previewInvite = async \(link: string\) => tool<any>\("onboard\.join\.read", \{ link \}\)/);
  assert.match(install, /acceptInvite = async \(link: string\) => tool<any>\("onboard\.space\.join", \{ link \}\)/);
  const join = fs.readFileSync(new URL("./team-join.ts", import.meta.url), "utf8");
  assert.match(join, /openServerPeer: peer\.openServerPeer/);
  assert.match(join, /signPresence: \(req\) => yes\.signer\.signPresence/);
});

test("the inviter's confirmation checks the Space's own four words: right words (any case or spacing) reach the kernel, wrong, empty or another Space's are refused in words and nothing is sent; five wrong tries stop the invite", async () => {
  const { confirmTeamInvite } = await import("./team-invite.js");
  const { fingerprintWords, spaceFingerprint } = await import("./join-team.js");
  const letters = "abcdefghij";
  const words = Array.from({ length: 2048 }, (_, i) => "w" + String(i).padStart(4, "0").replace(/\d/g, (c) => letters[Number(c)]));
  const space = { id: "spc_aaaaaaaaaaaa", payload: { rootPublic: "ROOTKEY" } };
  const right = /** @type {string} */ (fingerprintWords(words, spaceFingerprint(space.id, "ROOTKEY")));
  const other = /** @type {string} */ (fingerprintWords(words, spaceFingerprint("spc_bbbbbbbbbbbb", "OTHERKEY")));
  assert.notEqual(right, other);
  const sent = /** @type {any[]} */ ([]);
  const d = /** @type {any} */ ({ wire: { call: async (/** @type {string} */ c, /** @type {any[]} */ a) => { sent.push([c, a]); return { ok: true }; } }, fetch: async () => ({}), base: "http://x", words, resolveSpace: async () => space });
  for (const bad of [other, "", "apple apple apple apple", right.split(" ").slice(0, 3).join(" ")]) {
    await assert.rejects(() => confirmTeamInvite(d, "inv_1", bad, "harlow"), (e) => e.code === "words_mismatch" && /not the words of this Space.*read the four words on their card again/i.test(e.message), `"${bad}" is refused`);
  }
  assert.deepEqual(sent, [], "nothing was sent after the refusals");
  await confirmTeamInvite(d, "inv_1", `  ${right.toUpperCase()},  `, "harlow");
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], "grants.invites.confirm");
  for (let n = 0; n < 5; n++) await assert.rejects(() => confirmTeamInvite(d, "inv_2", "wrong words here now", "harlow"), (e) => e.code === "words_mismatch");
  await assert.rejects(() => confirmTeamInvite(d, "inv_2", right, "harlow"), (e) => e.code === "too_many_tries");
  assert.equal(sent.length, 1);
});

test("the shipped invite screen checks the Space's words before EVERY confirm path (the team wire, the home's spaces tool, the phone's approval), and a wrong word is refused with nothing sent", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../../screens/devices/RealInvite.tsx", import.meta.url), "utf8");
  const at = (/** @type {string} */ s) => { const i = src.indexOf(s); assert.ok(i >= 0, `missing: ${s}`); return i; };
  assert.ok(at("checkInviteWordsFor(card.id, made.id, words.trim(), card.name)") < at("confirmTeamInviteWords(card.id"), "the check comes before the team wire");
  assert.ok(at("checkInviteWordsFor(card.id") < at('tool("spaces.invites.confirm"'), "and before the home's tool (whose presence refusal the phone route answers)");
  assert.equal((src.match(/spaces\.invites\.confirm/g) || []).length, 2, "the screen has no other confirm call (one in the comment, one in the call)");
  const { checkInviteWords } = await import("./team-invite.js");
  const { fingerprintWords, spaceFingerprint } = await import("./join-team.js");
  const letters = "abcdefghij";
  const words = Array.from({ length: 2048 }, (_, i) => "w" + String(i).padStart(4, "0").replace(/\d/g, (c) => letters[Number(c)]));
  const space = { id: "spc_aaaaaaaaaaaa", payload: { rootPublic: "ROOTKEY" } };
  const right = /** @type {string} */ (fingerprintWords(words, spaceFingerprint(space.id, "ROOTKEY")));
  const d = /** @type {any} */ ({ fetch: async () => ({}), base: "http://x", wire: { call: async () => { throw new Error("nothing may be sent"); } }, words, resolveSpace: async () => space });
  await assert.rejects(() => checkInviteWords(d, "inv_9", "apple apple apple apple", "harlow"), (e) => e.code === "words_mismatch");
  await checkInviteWords(d, "inv_9", right, "harlow");
});
