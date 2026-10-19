// People on Settings > People and roles: who is in the space with their role (open one to change it), and the invitations waiting to be used with Revoke.
// Inviting is InviteBody's form, opened from the page's "Invite someone" button; this section only lists.
import { useState } from "react";
import { View } from "react-native";
import { Avatar, Banner, Button, Card, Chip, Divider, EmptyState, Row, Sheet, Text, markRef, showToast } from "@vyre/ui";
import { Sec } from "../places/Frame";
import { useMembers } from "../spaces/state";
import { ROLES, assignable, canManage, roleLabel, type Role } from "../spaces/roles.js";
import { joinedLine } from "../devices/invite.js";
import { MOCK } from "../../src/real/box";
import type { useInviteList } from "../devices/InviteBody";

type Invites = ReturnType<typeof useInviteList>;

export function PeopleSection({ mine, invites, onInvite }: { mine: string | undefined; invites: Invites; onInvite: () => void }) {
  const { members, selfId, setRole } = useMembers();
  const me = (["owner", "admin", "manager", "member", "temp"].includes(String(mine)) ? mine : "member") as Role;
  const allowed = assignable(me);
  const [pick, setPick] = useState<null | { id: string; role: Role }>(null);
  const [busy, setBusy] = useState(false);
  const who = pick ? members.find((m) => m.id === pick.id) : undefined;
  const save = () => {
    if (!pick || !who || pick.role === who.role) return;
    setBusy(true);
    void setRole(pick.id, pick.role).then((err) => { if (err) showToast(err); else { showToast(`${who.name} is now ${roleLabel(pick.role)}.`); setPick(null); } }).finally(() => setBusy(false));
  };
  const self = MOCK ? "alex" : selfId ?? "";
  const { open, joined, revoke } = invites;
  return (
    <>
      <Sec title="People" meta={members.length ? String(members.length) : undefined}>
        {members.length ? (
          <Card flush>
            {members.map((m, i) => {
              const can = canManage(me, m.role, m.id === self) && m.role !== "temp";
              return (
                <View key={m.id}>
                  {i ? <Divider inset={68} /> : null}
                  <Row dense lead={<Avatar of={markRef("person", m.name, m.id)} size={40} />} title={m.name} sub={m.role === "temp" && m.scope ? `Guest, only ${m.scope}` : roleLabel(m.role)}
                    chevron={can} onPress={can ? () => setPick({ id: m.id, role: m.role }) : undefined} accessibilityLabel={`${m.name}, ${roleLabel(m.role)}${can ? ", change role" : ""}`} />
                </View>
              );
            })}
          </Card>
        ) : <Card><EmptyState title="Just you so far" body="Invite someone and they show here once they join." action={allowed.length ? { label: "Invite someone", onPress: onInvite } : undefined} /></Card>}
      </Sec>
      {allowed.length ? (
        <Sec title="Waiting to join" meta={open && open.length ? String(open.length) : undefined}>
          {open === null ? <Card><EmptyState title="Loading" body="Asking your Vyre." /></Card> : open.length === 0 ? <Card><EmptyState title="Nobody is waiting" body="A link you make shows here until it is used or ends." /></Card> : (
            <Card flush>{open.map((i, k) => <View key={i.id}>{k ? <Divider /> : null}<Row title={i.title} sub={i.sub} end={<Button kind="holdText" size="sm" label="Revoke" onPress={() => revoke(i.id)} />} /></View>)}</Card>
          )}
          {joined.length ? <View className="pt-s3"><Card flush>{joined.map((i, k) => <View key={i.id}>{k ? <Divider /> : null}<Row title={i.title} sub={joinedLine(i)} end={<Chip tone="ok" icon="check">Joined</Chip>} /></View>)}</Card></View> : null}
        </Sec>
      ) : null}
      <Sheet open={!!pick} onClose={() => setPick(null)} title={who?.name}>
        {pick && who ? (
          <>
            <Text tone="muted">Their role in this space</Text>
            <View>
              {ROLES.filter((r) => r.id !== "temp" && (allowed.includes(r.id) || r.id === who.role)).map((r) => (
                <Row key={r.id} title={r.label} sub={<Text size="secondary" tone="label">{r.line}</Text>} selected={pick.role === r.id} onPress={allowed.includes(r.id) ? () => setPick({ ...pick, role: r.id }) : undefined} />
              ))}
            </View>
            <Banner icon="shield"><Text>A role of your own is given from Spaces and members.</Text></Banner>
            <View className="flex-row gap-s2"><Button kind="primary" label="Save" loading={busy} disabled={pick.role === who.role} onPress={save} /><Button kind="ghost" label="Cancel" onPress={() => setPick(null)} /></View>
          </>
        ) : null}
      </Sheet>
    </>
  );
}
