// Invite someone to a space on the real box: pick the role, make the link (spaces.invites.create), send it; the invites still open are listed with Revoke.
// An invite for an admin or owner waits for you to confirm the words the invitee reads to you (spaces.invites.confirm).
import { useCallback, useEffect, useState } from "react";
import { Linking, Platform, Share, View } from "react-native";
import { WinkCode } from "../../src/ui/WinkCode";
import { useRouter } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { Banner, Button, Card, Divider, EmptyState, Field, Row, Segmented, Text, showToast } from "@vyre/ui";
import { Page } from "../places/Frame";
import { useMembers } from "../spaces/state";
import { tool, said } from "../../src/real/box";
import { TEMP_DAYS, createInput, inviteRefusal, liveServers, inviteRow, invitable, joinedLine, madeNote, emailIt } from "./invite.js";

const why = (e: unknown) => inviteRefusal((e as { code?: string }).code, said(e));

export function RealInvite() {
  const { spaces, space, loading, error, load } = useMembers();
  useEffect(() => { void load(); }, [load]);
  const card = spaces.find((s) => s.id === space) ?? null;
  const roles = card ? invitable(card.role) : [];
  const [role, setRole] = useState("member");
  const [days, setDays] = useState("7");
  const [to, setTo] = useState("");
  const [anyone, setAnyone] = useState(false);
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
    tool<{ invites?: unknown[] }>("spaces.invites.list", { space }).then((r) => { const rows = (r?.invites ?? []).map(inviteRow); setOpen(rows.filter((i) => i.open)); setJoined(rows.filter((i) => !i.open && i.who)); }).catch(() => setOpen([]));
  }, [space]);
  useEffect(refresh, [refresh]);

  const make = () => {
    if (!card) return;
    setProblem(""); setWords("");
    if (!anyone && !to.trim()) { setProblem("Name the person this is for, or choose Anyone with the link."); return; }
    setBusy(true);
    tool("spaces.invites.create", createInput({ space: card.id, role, to, anyone, days: Number(days) })).then((r) => { setMade(madeNote(r)); refresh(); }).catch((e) => {
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
    tool("spaces.invites.confirm", { space: card.id, id: made.id, words: words.trim() }).then(() => { setMade({ ...made, needsConfirm: false }); showToast("Confirmed. The link works now."); refresh(); }).catch((e) => setProblem(why(e))).finally(() => setBusy(false));
  };
  const revoke = (id: string) => tool("spaces.invites.revoke", { space: card?.id, id }).then(() => { showToast("The link no longer works."); refresh(); }).catch((e) => showToast(why(e)));

  if (loading && !card) return <Page title="Invite someone" sub="They read one card and tap Join." back="/u/wink"><Card><EmptyState title="Loading" body="Asking your Vyre." /></Card></Page>;
  if (error && !card) return <Page title="Invite someone" sub="They read one card and tap Join." back="/u/wink"><Card><EmptyState title="Spaces did not answer" body={error} action={{ label: "Try again", onPress: () => void load() }} /></Card></Page>;
  if (!card) return <Page title="Invite someone" sub="They read one card and tap Join." back="/u/wink"><Card><EmptyState title="No space yet" body="Create a space first, then invite people to it." /></Card></Page>;
  if (!roles.length) return <Page title="Invite someone" sub={`To ${card.name}.`} back="/u/wink"><Card><EmptyState title="Only an owner or admin invites" body={`Ask an owner of ${card.name} to send the invitation.`} /></Card></Page>;

  return (
    <Page title="Invite someone" sub={`To ${card.name}. They read one card and tap Join.`} back="/u/wink">
      {made ? (
        <Card className="max-w-read gap-s3">
          <Text strong>The invitation is ready</Text>
          <Card className="flex-row items-center gap-s3"><Text mono size="caption" className="flex-1">{made.link}</Text><Button size="sm" label="Copy link" onPress={() => { Clipboard.setStringAsync(made.link).catch(() => {}); showToast("Copied"); }} /></Card>
          <WinkCode text={made.link} kind="join" space={card.name} typed={made.code} />
          <Text tone="muted">{made.line}</Text>
          <View className="flex-row flex-wrap gap-s2">
            <Button size="sm" label="Email it" onPress={() => {
              // The person's own mail app (or the share sheet on a phone): Vyre sends nothing.
              const e = emailIt(card.name, made.link);
              if (Platform.OS === "web") void Linking.openURL(e.mailto).catch(() => {}); else void Share.share({ title: e.subject, message: e.body }).catch(() => {});
            }} />
          </View>
          {made.needsConfirm ? (
            <View className="gap-s2">
              <Banner><Text>This role needs your yes. When they open the link they read you a few words. Type them here to let them in.</Text></Banner>
              <Field label="The words they read to you" value={words} onChangeText={setWords} />
              <View className="self-start"><Button kind="primary" label={busy ? "Checking" : "Confirm"} onPress={busy || !words.trim() ? () => {} : confirm} /></View>
            </View>
          ) : null}
          {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
          <View className="self-start"><Button kind="ghost" label="Make another" onPress={() => { setMade(null); setTo(""); }} /></View>
        </Card>
      ) : (
        <Card className="max-w-read gap-s3">
          <Segmented label="What they can do" value={role} onChange={setRole} options={roles.map((r) => [r.id, r.label] as [string, string])} />
          <Text size="caption" tone="label">{roles.find((r) => r.id === role)?.line}</Text>
          {role === "temp" ? <Segmented label="Access lasts" value={days} onChange={setDays} options={TEMP_DAYS as [string, string][]} /> : null}
          <Segmented label="Who may use it" value={anyone ? "anyone" : "named"} onChange={(v) => setAnyone(v === "anyone")} options={[["named", "One named person"], ["anyone", "Anyone with the link"]]} />
          {anyone ? <Banner tone="warn"><Text>Anyone who gets this link can join, so send it only to the person you mean. A named invite works for that person alone.</Text></Banner> : <Field label="Their Vyre name" help="Only that person can use the link." value={to} onChangeText={setTo} placeholder="sam.vyre.run" />}
          {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
          {onComputer ? <View className="flex-row"><Button label={onComputer === "pair" ? "Pair a server first" : "Make a space on your server"} onPress={() => router.push((onComputer === "pair" ? "/u/wink/add" : "/u/install/create") as never)} /></View> : null}
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
