// The invite flow on its own, so Settings > People and roles and the Wink page share one component: pick the role, make the link (onboard.member.link), hand it over; an invite for an admin or
// owner waits for you to confirm the words the invitee reads to you (spaces.invites.confirm). `useInviteList` is the open and joined invites of a space, with Revoke.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Banner, Button, Card, Field, Text, showToast } from "@vyre/ui";
import { isPhone } from "../install/first-run.js";
import { deviceKindHere } from "../../src/real/pair-say";
import { InviteRolePicker } from "../roles/InviteRolePicker";
import { InviteMade } from "./InviteMade";
import { roleLabel } from "../spaces/roles.js";
import type { SpaceCard } from "../spaces/data";
import { tool, said } from "../../src/real/box";
import { invitesHere } from "../../src/real/team-join";
import { inviteRefusal, liveServers, inviteRow, invitable, madeNote, requestInvite } from "./invite.js";

export const inviteWhy = (e: unknown) => inviteRefusal((e as { code?: string }).code, said(e), "", isPhone(deviceKindHere()) || deviceKindHere() === "web");

type Row = ReturnType<typeof inviteRow>;

/** The invites of a space: those still open (null while loading) and those used, and Revoke for an open one. */
export function useInviteList(space: string | null) {
  const [open, setOpen] = useState<Row[] | null>(null);
  const [joined, setJoined] = useState<Row[]>([]);
  const refresh = useCallback(() => {
    if (!space) return;
    void (async () => (await invitesHere() ? (await import("../../src/real/team-join")).teamInvites(space) : tool<{ invites?: unknown[] }>("spaces.invites.list", { space })))().then((r) => { const rows = (r?.invites ?? []).map(inviteRow); setOpen(rows.filter((i) => i.open)); setJoined(rows.filter((i) => !i.open && i.who)); }).catch(() => setOpen([]));
  }, [space]);
  useEffect(refresh, [refresh]);
  const revoke = (id: string) => void (async () => ((await invitesHere()) ? (await import("../../src/real/team-join")).cancelTeamInvite(String(space), id) : tool("spaces.invites.revoke", { space, id })))().then(() => { showToast("The link no longer works."); refresh(); }).catch((e) => showToast(inviteWhy(e)));
  return { open, joined, refresh, revoke };
}

/** The form and, once made, the link with Copy. `onChanged` runs after an invite is made or confirmed, so the caller can reload its list. */
export function InviteForm({ card, onChanged }: { card: SpaceCard; onChanged: () => void }) {
  const roles = invitable(card.role);
  const [role, setRole] = useState("member");
  const [days, setDays] = useState("7");
  const [projects, setProjects] = useState<string[]>([]);
  const [levels, setLevels] = useState<Record<string, string>>({});
  // Who it is for: kept here to label the card; the box's link tool takes no name, so it is not sent.
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<ReturnType<typeof madeNote> | null>(null);
  const [words, setWords] = useState("");
  const router = useRouter();
  const [problem, setProblem] = useState("");
  // A space that lives on one computer cannot have invitees (code this_computer): the way forward the app has is a new space on a server.
  const [onComputer, setOnComputer] = useState<"" | "server" | "pair">("");
  useEffect(() => { if (roles.length && !roles.some((r) => r.id === role)) setRole(roles[roles.length - 1].id); }, [roles.length]);

  const make = () => {
    setProblem(""); setWords("");
    setBusy(true);
    // Role and days are checked inside onboard.member.link, the same tool the first run uses.
    void requestInvite((name, input) => tool(name, input), { space: card.id, role, days: Number(days) }, { phone: isPhone(deviceKindHere()) || deviceKindHere() === "web" }).then((r) => {
      setBusy(false);
      if (r.ok) { setMade(r.made); onChanged(); return; }
      setProblem(r.why);
      if (r.code !== "this_computer") return;
      // The way forward depends on whether a server is paired (wink.access, rows of kind server): make a space on it, or pair one first.
      setOnComputer("server");
      void tool<any>("wink.access").then((a) => setOnComputer(liveServers(a).length ? "server" : "pair")).catch(() => {});
    });
  };
  const confirm = () => {
    if (!made || !words.trim()) return;
    setBusy(true); setProblem("");
    void (async () => { await (await import("../../src/real/team-join")).checkInviteWordsFor(card.id, made.id, words.trim(), card.name); return (await invitesHere()) ? (await import("../../src/real/team-join")).confirmTeamInviteWords(card.id, made.id, words.trim(), card.name) : tool("spaces.invites.confirm", { space: card.id, id: made.id, words: words.trim() }); })().then(() => { setMade({ ...made, needsConfirm: false }); showToast("Confirmed. The link works now."); onChanged(); }).catch((e) => setProblem(inviteWhy(e))).finally(() => setBusy(false));
  };

  return made ? (
    <View className="max-w-read gap-s3">
      <InviteMade space={{ id: card.id, name: card.name }} who={to.trim().replace(/^@/, "") || "them"} role={roleLabel(role)} line={made.line.split(". ")[0].replace(/\.$/, "")} code="" link={made.link} />
      <Text size="secondary" tone="label">They open it in Vyre and tap Join.</Text>
      {made.needsConfirm ? (
        <View className="gap-s2">
          <Banner><Text>This role needs your yes. When they open the link, their card shows four words of this Space. Ask them to read those words to you and type them here. The words show they are looking at this Space; they do not show who they are, so be sure it is the person you meant to invite.</Text></Banner>
          <Field label="The words they read to you" value={words} onChangeText={setWords} />
          <View className="self-start"><Button kind="primary" label={busy ? "Checking" : "Confirm"} onPress={busy || !words.trim() ? () => {} : confirm} /></View>
        </View>
      ) : null}
      {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
      <View className="self-start"><Button kind="ghost" label="Make another" onPress={() => { setMade(null); setTo(""); }} /></View>
    </View>
  ) : (
    <Card className="max-w-read gap-s3">
      <Field label="Their name or email, for your own list" value={to} onChangeText={setTo} placeholder="Sam, or sam@example.com" />
      <InviteRolePicker actor={card.role} role={role} onRole={setRole} projects={projects} onProjects={setProjects} levels={levels} onLevels={setLevels} days={days} onDays={setDays} />
      <Banner tone="warn"><Text>Anyone who gets this link can join, so send it only to the person you mean.</Text></Banner>
      {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
      {onComputer && !isPhone(deviceKindHere()) && deviceKindHere() !== "web" ? <View className="flex-row"><Button label={onComputer === "pair" ? "Pair a server first" : "Make a space on your server"} onPress={() => router.push("/onboard?path=create" as never)} /></View> : null}
      <View className="flex-row"><Button kind="primary" label={busy ? "Making" : "Make invite"} onPress={busy ? () => {} : make} /></View>
    </Card>
  );
}
