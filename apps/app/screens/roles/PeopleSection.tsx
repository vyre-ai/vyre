// People on Settings > People and roles: who is in the space with their role (open one to change it), and the invitations waiting to be used with Revoke.
// Inviting is InviteBody's form, opened from the page's "Invite someone" button; this section only lists.
import { useEffect, useState } from "react";
import { ROLE_IDS } from "../../../../kernel/contracts/index.js";
import { View } from "react-native";
import { Avatar, Banner, Button, Card, Chip, Divider, EmptyState, Row, Sheet, Text, markRef, showToast } from "@vyre/ui";
import { Sec } from "../places/Frame";
import { useMembers } from "../spaces/state";
import { ROLES, assignable, canManage, roleLabel, type Role } from "../spaces/roles.js";
import { joinedLine } from "../devices/invite.js";
import { MOCK, said, tool } from "../../src/real/box";
import { useProfiles } from "../../src/state/profiles";

/** A member's line: their role, and under it what they wrote About me in this Space. */
const withAbout = (role: string, about: string | undefined) => (about ? <View className="gap-s1"><Text size="secondary" tone="label" numberOfLines={1}>{role}</Text><Text size="secondary" tone="muted" numberOfLines={2}>{about}</Text></View> : role);
import type { useInviteList } from "../devices/InviteBody";

type Invites = ReturnType<typeof useInviteList>;

/** `custom` is the space's own roles (id and name), offered beside the built-in ones; `onChanged` runs after a role is given so the page can reload its counts. */
export function PeopleSection({ mine, invites, onInvite, custom, onChanged }: { mine: string | undefined; invites: Invites; onInvite: () => void; custom: { id: string; name: string }[]; onChanged: () => void }) {
  const { members, selfId, setRole, load, space } = useMembers();
  const me = ((ROLE_IDS as readonly string[]).includes(String(mine)) ? mine : "member") as Role;
  const allowed = assignable(me);
  const [pick, setPick] = useState<null | { id: string; role: string }>(null);
  const [busy, setBusy] = useState(false);
  const who = pick ? members.find((m) => m.id === pick.id) : undefined;
  // A member who holds a role of the space's own has its id in `custom` (spaces.members.list: role is the built-in one it stands on); the sheet starts on that role, else on their built-in one.
  const heldId = (m: { role: string; custom?: string }) => (m.custom && custom.some((c) => c.id === m.custom) ? m.custom : m.role);
  const save = () => {
    if (!pick || !who || pick.role === heldId(who)) return;
    setBusy(true);
    const isCustom = custom.some((c) => c.id === pick.role);
    const done = () => { showToast(`${who.name} is now ${isCustom ? custom.find((c) => c.id === pick.role)!.name : roleLabel(pick.role)}.`); setPick(null); onChanged(); };
    // A built-in role goes through spaces.members.set-role (as Spaces and members does); a role of the space's own through roles.assign.
    const give = async (): Promise<string | null> => {
      if (!isCustom) return setRole(pick.id, pick.role as Role);
      try { await tool("roles.assign", { space, person: pick.id, role: pick.role }); await load(space); return null; } catch (e) { return said(e); }
    };
    void give().then((err) => { if (err) showToast(err); else done(); }).finally(() => setBusy(false));
  };
  const self = MOCK ? "alex" : selfId ?? "";
  const { open, joined, revoke } = invites;
  // Each person's profile in this Space (their own name, look and About me), when they made one.
  const profiles = useProfiles((s) => (space ? s.bySpace[space]?.byPerson : undefined));
  const loadProfiles = useProfiles((s) => s.load);
  useEffect(() => { if (space) void loadProfiles(space); }, [space, loadProfiles]);
  const shownName = (m: { id: string; name: string }) => (m.id === self ? m.name : profiles?.[m.id]?.name || m.name);
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
                  <Row dense lead={<Avatar of={markRef("person", shownName(m), m.id, profiles?.[m.id]?.look || undefined)} size={40} />} title={shownName(m)}
                    sub={withAbout(m.role === "temp" && m.scope ? `Guest, only ${m.scope}` : m.role === "temp" ? roleLabel(m.role) : custom.find((c) => c.id === m.custom)?.name ?? roleLabel(m.role), profiles?.[m.id]?.about)}
                    chevron={can} onPress={can ? () => setPick({ id: m.id, role: heldId(m) }) : undefined} accessibilityLabel={`${shownName(m)}, ${roleLabel(m.role)}${can ? ", change role" : ""}`} />
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
              {custom.map((c) => <Row key={c.id} title={c.name} sub={<Text size="secondary" tone="label">A role of your own</Text>} selected={pick.role === c.id} onPress={() => setPick({ ...pick, role: c.id })} />)}
            </View>
            <View className="flex-row gap-s2"><Button kind="primary" label="Save" loading={busy} disabled={pick.role === heldId(who)} onPress={save} /><Button kind="ghost" label="Cancel" onPress={() => setPick(null)} /></View>
          </>
        ) : null}
      </Sheet>
    </>
  );
}
