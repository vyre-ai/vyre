// Invite someone to a space on the real box (the Wink page's entry): the form is InviteBody's, shared with Settings > People and roles; the invites still open are listed with Revoke.
import { useEffect } from "react";
import { View } from "react-native";
import { Button, Card, Divider, EmptyState, LoadingState, Row, Text } from "@vyre/ui";
import { Page } from "../places/Frame";
import { useMembers } from "../spaces/state";
import { joinedLine, invitable } from "./invite.js";
import { InviteForm, useInviteList } from "./InviteBody";

export function RealInvite() {
  const { spaces, space, loading, error, load } = useMembers();
  useEffect(() => { void load(); }, [load]);
  const card = spaces.find((s) => s.id === space) ?? null;
  const roles = card ? invitable(card.role) : [];
  const { open, joined, refresh, revoke } = useInviteList(space);

  if (loading && !card) return <Page title="Invite someone" sub="They read one card and tap Join." back="/u/wink"><Card flush><LoadingState rows={2} /></Card></Page>;
  if (error && !card) return <Page title="Invite someone" sub="They read one card and tap Join." back="/u/wink"><Card><EmptyState title="Spaces did not answer" body={error} action={{ label: "Try again", onPress: () => void load() }} /></Card></Page>;
  if (!card) return <Page title="Invite someone" sub="They read one card and tap Join." back="/u/wink"><Card><EmptyState title="No space yet" body="Create a space first, then invite people to it." /></Card></Page>;
  if (!roles.length) return <Page title="Invite someone" sub={`To ${card.name}.`} back="/u/wink"><Card><EmptyState title="Only an owner or admin invites" body={`Ask an owner of ${card.name} to send the invitation.`} /></Card></Page>;

  return (
    <Page title="Invite someone" sub={`To ${card.name}. They read one card and tap Join.`} back="/u/wink">
      <InviteForm card={card} onChanged={refresh} />
      <Text size="caption" strong tone="label">Still open</Text>
      {open === null ? <Card flush><LoadingState rows={2} /></Card> : open.length === 0 ? <Card><EmptyState title="No open invitations" body="A link you make shows here until it is used or ends." /></Card> : (
        <Card flush>{open.map((i, k) => <View key={i.id}>{k ? <Divider /> : null}<Row title={i.title} sub={i.sub} end={<Button kind="holdText" size="sm" label="Revoke" onPress={() => revoke(i.id)} />} /></View>)}</Card>
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
