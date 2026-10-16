// Invite someone to a space on the real box: pick the role, make the link (spaces.invites.create), send it; the invites still open are listed with Revoke.
// An invite for an admin or owner waits for you to confirm the words the invitee reads to you (spaces.invites.confirm).
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { isPhone } from "../install/first-run.js";
import { deviceKindHere } from "../../src/real/pair-say";
import { AckCode } from "./TypeCode";
import { useRouter } from "expo-router";
import { Banner, Button, Card, Divider, EmptyState, Field, Row, Text, showToast } from "@vyre/ui";
import { Page } from "../places/Frame";
import { InviteRolePicker } from "../roles/InviteRolePicker";
import { InviteMade } from "./InviteMade";
import { roleLabel } from "../spaces/roles.js";
import { useMembers } from "../spaces/state";
import { tool, said } from "../../src/real/box";
import { invitesHere } from "../../src/real/team-join";
import { inviteRefusal, liveServers, inviteRow, invitable, joinedLine, madeNote } from "./invite.js";

const why = (e: unknown) => inviteRefusal((e as { code?: string }).code, said(e), "", isPhone(deviceKindHere()) || deviceKindHere() === "web");

export function RealInvite() {
  const { spaces, space, loading, error, load } = useMembers();
  useEffect(() => { void load(); }, [load]);
  const card = spaces.find((s) => s.id === space) ?? null;
  const roles = card ? invitable(card.role) : [];
  const [role, setRole] = useState("member");
  const [days, setDays] = useState("7");
  const [projects, setProjects] = useState<string[]>([]);
  const [levels, setLevels] = useState<Record<string, string>>({});
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<ReturnType<typeof madeNote> | null>(null);
  const [words, setWords] = useState("");
  const router = useRouter();
  const [problem, setProblem] = useState("");
  // A space that lives on one computer cannot have invitees (code this_computer): the way forward the app has is a new space on a server.
  const [onComputer, setOnComputer] = useState<"" | "server" | "pair">("");
  const [open, setOpen] = useState<ReturnType<typeof inviteRow>[] | null>(null);
  const [joined, setJoined] = useState<ReturnType<typeof inviteRow>[]>([]);
  useEffect(() => { if (roles.length && !roles.some((r) => r.id === role)) setRole(roles[roles.length - 1].id); }, [roles.length]);

  const refresh = useCallback(() => {
    if (!space) return;
    void (async () => (await invitesHere() ? (await import("../../src/real/team-join")).teamInvites(space) : tool<{ invites?: unknown[] }>("spaces.invites.list", { space })))().then((r) => { const rows = (r?.invites ?? []).map(inviteRow); setOpen(rows.filter((i) => i.open)); setJoined(rows.filter((i) => !i.open && i.who)); }).catch(() => setOpen([]));
  }, [space]);
  useEffect(refresh, [refresh]);

  const make = () => {
    if (!card) return;
    setProblem(""); setWords("");
    setBusy(true);
    // Role and days are checked inside onboard.member.link, the same tool the first run uses.
    void tool("onboard.member.link", { space: card.id, role: role === "temp" ? "guest" : role, ttlDays: Number(days) }).then((r) => { setMade(madeNote(r)); refresh(); }).catch((e) => {
      setProblem(why(e));
      if ((e as { code?: string }).code !== "this_computer") return;
      // The way forward depends on whether a server is paired (wink.access, rows of kind server): make a space on it, or pair one first.
      setOnComputer("server");
      void tool<any>("wink.access").then((a) => setOnComputer(liveServers(a).length ? "server" : "pair")).catch(() => {});
    }).finally(() => setBusy(false));
  };
  const confirm = () => {
    if (!card || !made || !words.trim()) return;
    setBusy(true); setProblem("");
    void (async () => { await (await import("../../src/real/team-join")).checkInviteWordsFor(card.id, made.id, words.trim(), card.name); return (await invitesHere()) ? (await import("../../src/real/team-join")).confirmTeamInviteWords(card.id, made.id, words.trim(), card.name) : tool("spaces.invites.confirm", { space: card.id, id: made.id, words: words.trim() }); })().then(() => { setMade({ ...made, needsConfirm: false }); showToast("Confirmed. The link works now."); refresh(); }).catch((e) => setProblem(why(e))).finally(() => setBusy(false));
  };
  const revoke = (id: string) => void (async () => ((await invitesHere()) ? (await import("../../src/real/team-join")).cancelTeamInvite(String(card?.id), id) : tool("spaces.invites.revoke", { space: card?.id, id })))().then(() => { showToast("The link no longer works."); refresh(); }).catch((e) => showToast(why(e)));

  if (loading && !card) return <Page title="Invite someone" sub="They read one card and tap Join." back="/u/wink"><Card><EmptyState title="Loading" body="Asking your Vyre." /></Card></Page>;
  if (error && !card) return <Page title="Invite someone" sub="They read one card and tap Join." back="/u/wink"><Card><EmptyState title="Spaces did not answer" body={error} action={{ label: "Try again", onPress: () => void load() }} /></Card></Page>;
  if (!card) return <Page title="Invite someone" sub="They read one card and tap Join." back="/u/wink"><Card><EmptyState title="No space yet" body="Create a space first, then invite people to it." /></Card></Page>;
  if (!roles.length) return <Page title="Invite someone" sub={`To ${card.name}.`} back="/u/wink"><Card><EmptyState title="Only an owner or admin invites" body={`Ask an owner of ${card.name} to send the invitation.`} /></Card></Page>;

  return (
    <Page title="Invite someone" sub={`To ${card.name}. They read one card and tap Join.`} back="/u/wink">
      {made ? (
        <View className="max-w-read gap-s3">
          <InviteMade space={{ id: card.id, name: card.name }} who={to.trim().replace(/^@/, "") || "them"} role={roleLabel(role)} line={made.line.split(". ")[0].replace(/\.$/, "")} code={made.code ?? ""} link={made.link} />
          {made.code && made.codeOffer ? <AckCode offer={made.codeOffer} onDone={() => showToast("Confirmed. They can join now.")} /> : null}
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
          <InviteRolePicker actor={card.role} role={role} onRole={setRole} projects={projects} onProjects={setProjects} levels={levels} onLevels={setLevels} days={days} onDays={setDays} />
          <Field label="Their name, for your own list" value={to} onChangeText={setTo} placeholder="Sam" />
          <Banner tone="warn"><Text>Anyone who gets this link can join, so send it only to the person you mean.</Text></Banner>
          {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
          {onComputer && !isPhone(deviceKindHere()) && deviceKindHere() !== "web" ? <View className="flex-row"><Button label={onComputer === "pair" ? "Pair a server first" : "Make a space on your server"} onPress={() => router.push((onComputer === "pair" ? "/u/wink/add" : "/u/install/create") as never)} /></View> : null}
          <View className="flex-row"><Button kind="primary" label={busy ? "Making" : "Make the invitation"} onPress={busy ? () => {} : make} /></View>
        </Card>
      )}
      <Text size="caption" strong tone="label">Still open</Text>
      {open === null ? <Card><EmptyState title="Loading" body="Asking your Vyre." /></Card> : open.length === 0 ? <Card><EmptyState title="No open invitations" body="A link you make shows here until it is used or ends." /></Card> : (
        <Card flush>{open.map((i, k) => <View key={i.id}>{k ? <Divider /> : null}<Row title={i.title} sub={i.sub} end={<Button kind="holdText" size="sm" label="Revoke" onPress={() => void revoke(i.id)} />} /></View>)}</Card>
      )}
      {joined.length ? (
        <>
          <Text size="caption" strong tone="label">Recently joined</Text>
          <Card flush>{joined.map((i, k) => <View key={i.id}>{k ? <Divider /> : null}<Row title={i.title} sub={joinedLine(i)} /></View>)}</Card>
        </>
      ) : null}
    </Page>
  );
}
