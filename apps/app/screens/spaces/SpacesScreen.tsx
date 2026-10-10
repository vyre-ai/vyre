import { ROLE_IDS } from "../../../../kernel/contracts/index.js";
import { useEffect, useState } from "react";
import { ZoneSection } from "./ZoneSection";
import { ComputersLately } from "../runner/ComputersLately";
import { MyCloudCard } from "../settings/MyCloudCard";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Avatar, Banner, Button, Card, Menu, Chip, Divider, Field, Row, Segmented, Sheet, Text, showToast, markRef, spaceRef, haptic } from "@vyre/ui";
import { Footnote, Page, Sec } from "../places/Frame";
import { usePhone } from "../places/Page";
import { useSpaces } from "../shell/state";
import { loadTeammates, TEMP_PROJECTS, type Member } from "./data";
import { MOCK, said, tool } from "../../src/real/box";
import { useMembers } from "./state";
import { loadSetupElsewhere } from "../install/data";
import { CONTINUE_HERE, isResumable, packProgress, setupElsewhere } from "../install/flow.js";
import { applyClaim } from "../install/real.js";
import { writeProgress } from "../../src/state/setup-progress";
import { EXTENSIONS, ROLES, TEMP_ENDS, endDate as endDateOf, assignable, canManage, ownerMoveLine, roleLabel, type Role } from "./roles.js";

const TEAM = MOCK ? loadTeammates() : [];

type Sheetv = null | { kind: "role"; id: string; role: Role; scope: string; days: string } | { kind: "extend"; id: string } | { kind: "temp"; name: string; scope: string; days: string };

export function SpacesScreen() {
  const router = useRouter();
  const phone = usePhone();
  const { members, spaces: SPACES, projects, warnings, error, loading, space, selfId, deviceId, load, setRole, remove, extendBy, addTemp } = useMembers();
  useEffect(() => { void load(); }, [load]);
  const cur = SPACES.find((x) => x.id === space);
  const MY_ROLE = (MOCK ? "admin" : (ROLE_IDS as readonly string[]).includes(cur?.role ?? "") ? cur!.role : "member") as Role;
  const ME = MOCK ? "alex" : selfId ?? "";
  const OWNER = members.find((m) => m.role === "owner")?.name ?? "its owner";
  const projectNames = MOCK ? TEMP_PROJECTS : projects.map((p) => p.name);
  const spaceName = cur?.name ?? "this space";
  const ELSEWHERE = MOCK ? loadSetupElsewhere() : (() => { const s = SPACES.find((x) => x.setup && x.setup.device.id !== deviceId); return s?.setup ? { device: s.setup.device.name, space: s.id, spaceName: s.name } : null; })();
  const fail = (m: string | null) => { if (m) showToast(m); return m === null; };
  const setShowing = useSpaces((s) => s.setShowing);
  const [sheet, setSheet] = useState<Sheetv>(null);
  const member = (id: string) => members.find((m) => m.id === id);
  const open = (m: Member) => setSheet({ kind: "role", id: m.id, role: m.role, scope: m.scope ?? projectNames[0] ?? "", days: String(m.left && m.left > 30 ? 90 : m.left && m.left > 7 ? 30 : 7) });
  const allowed = assignable(MY_ROLE);
  // Inviting, adding a temp member and extending one are admin acts: a role that cannot do them is not offered them.
  const canInvite = allowed.length > 0;

  return (
    <Page title="Spaces and members" sub="Where your things live, and who is in them." back="/u/settings"
      actions={<Menu trigger={<Button kind="primary" size={phone ? "md" : "sm"} icon="plus" label="Add a space" />} items={[{ label: "Create a space", onPress: () => router.push("/u/install/create" as never) }, { label: "Join a space", onPress: () => router.push("/u/install/join" as never) }]} />}>
      {MOCK ? null : <MyCloudCard />}
      {ELSEWHERE ? (
        <Banner icon="refresh">
          <View className="gap-s2">
            <Text strong>{setupElsewhere(ELSEWHERE.device)}</Text>
            <Text size="caption" tone="muted">{`${ELSEWHERE.spaceName} is paired. The rest of its setup carries on from there, or from here.`}</Text>
            <View className="self-start"><Button size="sm" label={CONTINUE_HERE} onPress={() => {
              const keep = (step: string, name: string, addr: string | null, look: string, where: string) => writeProgress(packProgress({ step: isResumable(step) ? step : "look", name: MOCK ? "alex" : "", spaceName: name, addr, look, where, pairTo: "me", device: "this" })).then(() => router.push("/u/install/create" as never));
              if (MOCK) { void keep("look", ELSEWHERE.spaceName, ELSEWHERE.space, "amber", "server"); return; }
              // The claim answers where the setup stood; resume there, with the space's own name and look, not the space id.
              void tool("spaces.setup.claim", { space: ELSEWHERE.space }).then((c) => { const a = applyClaim(c); return keep(a?.step ?? "look", a?.name || ELSEWHERE.spaceName, a?.addr ?? null, a?.look ?? "amber", a?.where ?? "server"); }, (e) => showToast(said(e)));
            }} /></View>
          </View>
        </Banner>
      ) : null}
      {error ? <Banner icon="refresh"><Text tone="warn">{error}</Text></Banner> : null}
      {!MOCK && !loading && !error && !SPACES.length ? <Card><Text tone="muted">No spaces yet. Create one, or join one from a link.</Text></Card> : null}
      <View className="flex-row flex-wrap gap-s3">
        {SPACES.map((s) => (
          <Card flush key={s.id} className="min-w-menu flex-1">
            <Row lead={<Avatar of={spaceRef(s.name)} size={56} />} title={s.name} chevron className="py-s3"
              sub={<View className="gap-s1"><Text mono size="secondary" tone="label" numberOfLines={1}>{s.address}</Text><Text size="secondary" tone="label" numberOfLines={1}>{`${roleLabel(s.role as Role)}, lives on ${s.home}`}</Text></View>}
              onPress={() => { setShowing(s.id); router.push("/u/now" as never); }} />
          </Card>
        ))}
      </View>
      {cur && canInvite && !MOCK ? <ZoneSection space={cur.id} zone={(cur as { zone?: string | null }).zone ?? null} spaceName={spaceName} onSaved={() => void load()} /> : null}
      {cur && canInvite && !MOCK ? <ComputersLately space={cur.id} /> : null}
      <Sec title={`Members of ${spaceName}`}>
        <Card flush>
          {members.map((m, i) => {
            const self = m.id === ME;
            const can = canManage(MY_ROLE, m.role, self);
            const temp = m.role === "temp";
            return (
              <View key={m.id}>
                {i ? <Divider inset={68} /> : null}
                <Row dense lead={<Avatar of={markRef("person", m.name, m.id)} size={40} />} title={m.name}
                  end={temp && can ? <Button kind="ghost" size="sm" label="Extend" onPress={() => setSheet({ kind: "extend", id: m.id })} /> : undefined}
                  sub={temp ? (
                    <View className="gap-s1 pt-s1">
                      <Text size="secondary" tone="label" numberOfLines={1}>{`Only ${m.scope}`}</Text>
                      <View className="flex-row items-center gap-s2"><Chip tone="warn">{`Temp, ends ${m.end}`}</Chip></View>
                    </View>
                  ) : roleLabel(m.role)}
                  onPress={can ? () => open(m) : undefined} />
              </View>
            );
          })}
          {TEAM.map((t) => <View key={t.id}><Divider inset={68} /><Row dense lead={<Avatar of={markRef(t.id === "juno" || t.name === "juno" ? "assistant" : "teammate", t.name, t.id)} size={40} />} title={t.name} sub={t.sub} /></View>)}
        </Card>
        {canInvite ? (
          <View className="gap-s1 pt-s3">
            <Button kind="primary" size="lg" className={phone ? undefined : "self-start"} icon="plus" label="Invite someone" onPress={() => router.push("/u/wink/invite" as never)} />
            <Button kind="ghost" label="Add a temp member" onPress={() => setSheet({ kind: "temp", name: "", scope: projectNames[0] ?? "", days: "7" })} />
          </View>
        ) : cur ? <Footnote>{`Your role in ${spaceName} is ${roleLabel(MY_ROLE)}. An owner or admin invites people and changes roles.`}</Footnote> : null}
      </Sec>
      {warnings.map((w) => <Footnote key={w}>{w}</Footnote>)}
      {cur ? <Footnote>Temp access ends on its date. An owner or admin can extend it with one tap.</Footnote> : null}

      <Sheet open={sheet?.kind === "role"} onClose={() => setSheet(null)} title={sheet?.kind === "role" ? member(sheet.id)?.name : undefined}>
        {sheet?.kind === "role" ? (
          <>
            <Text tone="muted">{`Role in ${spaceName}`}</Text>
            <View>
              {ROLES.filter((r) => allowed.includes(r.id) || r.id === "owner" || r.id === member(sheet.id)?.role).map((r) => (
                <Row key={r.id} title={r.label} sub={<Text size="secondary" tone="label">{r.id === "owner" ? ownerMoveLine(OWNER) : r.line}</Text>} selected={sheet.role === r.id} onPress={allowed.includes(r.id) ? () => setSheet({ ...sheet, role: r.id }) : undefined} />
              ))}
            </View>
            {sheet.role === "temp" ? (
              <View className="gap-s3">
                <Segmented label="Only this project" value={sheet.scope} onChange={(v) => setSheet({ ...sheet, scope: v })} options={projectNames.map((p) => [p, p] as [string, string])} />
                <Segmented label="Ends" value={sheet.days} onChange={(v) => setSheet({ ...sheet, days: v })} options={TEMP_ENDS as [string, string][]} />
              </View>
            ) : null}
            <View className="flex-row flex-wrap gap-s2">
              <Button kind="primary" label="Save" disabled={(sheet.role === "temp" && !sheet.scope) || (sheet.role === member(sheet.id)?.role && sheet.role !== "temp")} onPress={() => { const m = member(sheet.id)!; const to = sheet.role; setSheet(null); void setRole(m.id, to, { scope: sheet.scope, days: Number(sheet.days) }).then((e) => { if (fail(e)) { haptic.approve(); showToast(`${m.name} is now ${roleLabel(to)}.`); } }); }} />
              <Button kind="ghost" label="Cancel" onPress={() => setSheet(null)} />
              <View className="flex-1" />
              <Button kind="hold" label={`Remove ${member(sheet.id)?.name}`} onPress={() => { const m = member(sheet.id)!; setSheet(null); void remove(m.id).then((e) => { if (fail(e)) showToast(`${m.name} was removed from ${spaceName}.`); }); }} />
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
                    // Lead ruling 4 Oct: a live person session is the presence. The tap is the grant change; the sign-in appears only if the session has lapsed.
                    setSheet(null);
                    void extendBy(m.id, Number(d)).then((e) => { if (fail(e)) showToast(`${m.name} keeps access to ${m.scope} until ${endDateOf((m.left ?? 0) + Number(d))}.`); });
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
            <Field label={MOCK ? "Name" : "Their Vyre name"} value={sheet.name} onChangeText={(v) => setSheet({ ...sheet, name: v })} placeholder={MOCK ? "Their name" : "name.vyre.run"} />
            <Segmented label="Only this project" value={sheet.scope} onChange={(v) => setSheet({ ...sheet, scope: v })} options={projectNames.map((p) => [p, p] as [string, string])} />
            <Segmented label="Ends" value={sheet.days} onChange={(v) => setSheet({ ...sheet, days: v })} options={TEMP_ENDS as [string, string][]} />
            <View className="flex-row gap-s2">
              <Button kind="primary" label={MOCK ? "Send invite" : "Add"} disabled={!sheet.name.trim() || (!MOCK && !projectNames.length)} onPress={() => {
                const name = sheet.name.trim();
                setSheet(null);
                void addTemp({ ...withTemp(name, sheet.scope, Number(sheet.days)), person: name }).then((e) => { if (fail(e)) showToast(MOCK ? `Invite sent to ${name}.` : `${name} was added.`); });
              }} />
              <Button kind="ghost" label="Cancel" onPress={() => setSheet(null)} />
            </View>
          </>
        ) : null}
      </Sheet>
    </Page>
  );
}

function withTemp(name: string, scope: string, days: number): Member {
  return { id: `t${name.toLowerCase().replace(/[^a-z0-9]/g, "")}`, name, role: "temp", scope, left: days, end: endDateOf(days) };
}
