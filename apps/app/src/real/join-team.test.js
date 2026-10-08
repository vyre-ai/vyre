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

test("install.ts joins from this app when it holds the name, and from the box otherwise; the app's own side is in team-join.ts", () => {
  const install = fs.readFileSync(new URL("./install.ts", import.meta.url), "utf8");
  assert.match(install, /previewInvite = async \(link: string\) => \{ const t = await import\("\.\/team-join"\); return \(await t\.holdsName\(\)\) \? t\.previewTeamInvite\(link\) : tool<any>\("spaces\.invites\.preview"/);
  assert.match(install, /acceptInvite = async \(link: string\) => \{ const t = await import\("\.\/team-join"\); return \(await t\.holdsName\(\)\) \? t\.acceptTeamInvite\(link\) : tool<any>\("spaces\.invites\.accept"/);
  const join = fs.readFileSync(new URL("./team-join.ts", import.meta.url), "utf8");
  assert.match(join, /openServerPeer: peer\.openServerPeer/);
  assert.match(join, /signPresence: \(req\) => yes\.signer\.signPresence/);
});
