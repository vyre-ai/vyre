import { useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Avatar, Banner, Button, Card, Chip, Divider, Field, Row, Segmented, Sheet, Text, showToast } from "@vyre/ui";
import { Group, Page } from "../shell/Page";
import { FaceIdSheet, type FaceAsk } from "../shell/FaceIdSheet";
import { useSpaces } from "../shell/state";
import { loadSpaces, loadTeammates, ME, TEMP_PROJECTS, type Member } from "./data";
import { useMembers } from "./state";
import { EXTENSIONS, ROLES, TEMP_ENDS, endDate as endDateOf, assignable, canManage, endingSoon, roleLabel, tempLine, type Role } from "./roles.js";

const SPACES = loadSpaces();
const TEAM = loadTeammates();
const MY_ROLE: Role = "admin";

function RoleChip({ role }: { role: Role }) {
  return <Chip tone={role === "owner" ? "accent" : role === "temp" ? "warn" : "plain"}>{roleLabel(role)}</Chip>;
}

type Sheetv = null | { kind: "role"; id: string; role: Role; scope: string; days: string } | { kind: "extend"; id: string } | { kind: "temp"; name: string; scope: string; days: string };

export function SpacesScreen() {
  const router = useRouter();
  const { members, setRole, remove, extendBy, addTemp } = useMembers();
  const setShowing = useSpaces((s) => s.setShowing);
  const [sheet, setSheet] = useState<Sheetv>(null);
  const [face, setFace] = useState<FaceAsk | null>(null);
  const member = (id: string) => members.find((m) => m.id === id);
  const open = (m: Member) => setSheet({ kind: "role", id: m.id, role: m.role, scope: m.scope ?? TEMP_PROJECTS[0], days: String(m.left && m.left > 30 ? 90 : m.left && m.left > 7 ? 30 : 7) });
  const allowed = assignable(MY_ROLE);

  return (
    <Page title="Spaces and members" sub="Where your things live, and who is in them."
      actions={<><Button label="Join a space" onPress={() => router.push("/u/install/join" as never)} /><Button kind="primary" icon="plus" label="Create a space" onPress={() => router.push("/u/install/create" as never)} /></>}>
      <View className="flex-row flex-wrap gap-s3">
        {SPACES.map((s) => (
          <Card key={s.id} className="min-w-menu flex-1 gap-s3">
            <Row lead={<Avatar name={s.name} family="space" size="lg" tint />} title={s.name} sub={s.address} className="px-0" />
            <Text tone="muted">{`You are ${s.role === "owner" ? "an owner" : "an admin"}. Lives on ${s.home}.`}</Text>
            <View className="flex-row"><Button size="sm" label="Open" onPress={() => { setShowing(s.id); router.push("/u/now" as never); }} /></View>
          </Card>
        ))}
      </View>
      <Group title="Members of Harlow Legal">
        <Card flush>
          {members.map((m, i) => {
            const self = m.id === ME;
            const can = canManage(MY_ROLE, m.role, self);
            return (
              <View key={m.id}>
                {i ? <Divider /> : null}
                <Row lead={<Avatar name={m.name} />} title={m.name}
                  sub={m.role === "temp" ? tempLine(m) : roleLabel(m.role)}
                  onPress={can ? () => open(m) : undefined}
                  end={<>{m.role === "temp" ? <Button size="sm" kind={endingSoon(m) ? "primary" : "secondary"} label="Extend" onPress={() => setSheet({ kind: "extend", id: m.id })} /> : null}<RoleChip role={m.role} /></>} />
              </View>
            );
          })}
          {TEAM.map((t) => <View key={t.id}><Divider /><Row lead={<Avatar name={t.name} family="assistant" />} title={t.name} sub={t.sub} /></View>)}
        </Card>
        <View className="flex-row flex-wrap gap-s2">
          <Button kind="primary" size="sm" icon="plus" label="Invite someone" onPress={() => router.push("/u/wink/invite" as never)} />
          <Button size="sm" label="Add a temp member" onPress={() => setSheet({ kind: "temp", name: "", scope: TEMP_PROJECTS[0], days: "7" })} />
        </View>
      </Group>
      <Banner>Temp access ends on its date. One tap extends it, with Face ID.</Banner>

      <Sheet open={sheet?.kind === "role"} onClose={() => setSheet(null)} title={sheet?.kind === "role" ? member(sheet.id)?.name : undefined}>
        {sheet?.kind === "role" ? (
          <>
            <Text tone="muted">Role in Harlow Legal</Text>
            <View>
              {ROLES.filter((r) => allowed.includes(r.id) || r.id === member(sheet.id)?.role).map((r) => (
                <Row key={r.id} title={r.label} sub={r.line} selected={sheet.role === r.id} onPress={allowed.includes(r.id) ? () => setSheet({ ...sheet, role: r.id }) : undefined} />
              ))}
            </View>
            {sheet.role === "temp" ? (
              <View className="gap-s3">
                <Segmented label="Only this project" value={sheet.scope} onChange={(v) => setSheet({ ...sheet, scope: v })} options={TEMP_PROJECTS.map((p) => [p, p] as [string, string])} />
                <Segmented label="Ends" value={sheet.days} onChange={(v) => setSheet({ ...sheet, days: v })} options={TEMP_ENDS as [string, string][]} />
              </View>
            ) : null}
            <View className="flex-row flex-wrap gap-s2">
              <Button kind="primary" label="Save" onPress={() => { const m = member(sheet.id)!; setRole(m.id, sheet.role, { scope: sheet.scope, days: Number(sheet.days) }); setSheet(null); showToast(`${m.name} is now ${roleLabel(sheet.role)}.`); }} />
              <Button kind="ghost" label="Cancel" onPress={() => setSheet(null)} />
              <View className="flex-1" />
              <Button kind="hold" label={`Remove ${member(sheet.id)?.name}`} onPress={() => { const m = member(sheet.id)!; remove(m.id); setSheet(null); showToast(`${m.name} was removed from Harlow Legal.`); }} />
            </View>
          </>
        ) : null}
      </Sheet>

      <Sheet open={sheet?.kind === "extend"} onClose={() => setSheet(null)} title={sheet?.kind === "extend" ? `Extend ${member(sheet.id)?.name}` : undefined}>
        {sheet?.kind === "extend" ? (() => {
          const m = member(sheet.id)!;
          return (
            <>
              <Text tone="muted">{`Now sees only ${m.scope}, until ${m.end}.`}</Text>
              <View>
                {EXTENSIONS.map(([d, label]) => (
                  <Row key={d} title={label} onPress={() => {
                    setSheet(null);
                    setFace({ title: "Extend access", body: `Face ID confirms it is you. ${m.name} keeps seeing ${m.scope} for ${d} more days.`, onApprove: () => { extendBy(m.id, Number(d)); showToast("Access extended."); } });
                  }} />
                ))}
              </View>
              <View className="flex-row"><Button kind="ghost" label="Cancel" onPress={() => setSheet(null)} /></View>
            </>
          );
        })() : null}
      </Sheet>

      <Sheet open={sheet?.kind === "temp"} onClose={() => setSheet(null)} title="Add a temp member">
        {sheet?.kind === "temp" ? (
          <>
            <Text tone="muted">They see one project until the end date.</Text>
            <Field label="Name" value={sheet.name} onChangeText={(v) => setSheet({ ...sheet, name: v })} placeholder="Their name" />
            <Segmented label="Only this project" value={sheet.scope} onChange={(v) => setSheet({ ...sheet, scope: v })} options={TEMP_PROJECTS.map((p) => [p, p] as [string, string])} />
            <Segmented label="Ends" value={sheet.days} onChange={(v) => setSheet({ ...sheet, days: v })} options={TEMP_ENDS as [string, string][]} />
            <View className="flex-row gap-s2">
              <Button kind="primary" label="Send invite" disabled={!sheet.name.trim()} onPress={() => {
                const name = sheet.name.trim();
                addTemp(withTemp(name, sheet.scope, Number(sheet.days)));
                setSheet(null); showToast(`Invite sent to ${name}.`);
              }} />
              <Button kind="ghost" label="Cancel" onPress={() => setSheet(null)} />
            </View>
          </>
        ) : null}
      </Sheet>
      <FaceIdSheet ask={face} onClose={() => setFace(null)} />
    </Page>
  );
}

function withTemp(name: string, scope: string, days: number): Member {
  return { id: `t${name.toLowerCase().replace(/[^a-z0-9]/g, "")}`, name, role: "temp", scope, left: days, end: endDateOf(days) };
}
