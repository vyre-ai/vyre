import { View } from "react-native";
import { useRouter } from "expo-router";
import { Avatar, Banner, Button, Card, Chip, Divider, EmptyState, Row, Segmented, Switch, Text, markRef } from "@vyre/ui";
import { Group, Page } from "../places/Frame";
import { useTypes } from "../customize/state";
import { PRIVACY_ROWS, RETENTION } from "./logic.js";
import { RECORD_COUNTS, SEEING } from "./data";
import { useSettings } from "./state";

/** What my assistants can see, per assistant. */
export function SeeingScreen() {
  const router = useRouter();
  return (
    <Page title="What my assistants can see" back="/u/settings">
      <Card flush>
        {SEEING.map((a, i) => <View key={a.id}>{i ? <Divider /> : null}<Row lead={<Avatar of={markRef(a.family, a.name)} />} title={a.name} sub={`Works in ${a.works}`} end={<Button kind="ghost" size="sm" label="Memory" onPress={() => router.push("/u/memory" as never)} />} /></View>)}
      </Card>
      <Banner>Sealed fields stay hidden from every assistant. That includes yours and anyone acting for you. A space's admins decide what is sealed.</Banner>
      <View className="flex-row"><Button size="sm" label="Privacy and sealing" onPress={() => router.push("/u/settings/privacy" as never)} /></View>
    </Page>
  );
}

/** Privacy and sealing for the space showing (admins only): defaults, the sealed fields, how long facts are kept. */
export function PrivacyScreen() {
  const router = useRouter();
  const { priv, setPriv } = useSettings();
  const types = useTypes((s) => s.types).filter((t) => t.spaces.includes("harlow"));
  const sealed = types.flatMap((t) => t.fields.filter((f) => f.sealed).map((f) => ({ t, f })));
  const on = (k: string) => (priv as Record<string, any>)[k] as boolean;
  return (
    <Page title="Privacy and sealing" sub="Harlow Legal · admins only" back="/u/settings">
      <Card flush>
        {PRIVACY_ROWS.map(([k, t, sub], i) => <View key={k}>{i ? <Divider /> : null}<Row title={t} sub={sub} end={<Switch label={t} on={on(k)} onChange={(v) => setPriv({ [k]: v })} />} /></View>)}
      </Card>
      <Group title="Sealed fields">
        <Card flush>
          {sealed.length ? sealed.map(({ t, f }, i) => (
            <View key={t.id + f.key}>{i ? <Divider /> : null}<Row lead={<Chip tone="sealed" icon="vault">Sealed</Chip>} title={`${t.label}, ${f.label}`} sub={`Hidden from every assistant on all ${RECORD_COUNTS[t.id] ?? 0} records`} onPress={() => router.push(`/u/settings/customize/${t.id}` as never)} /></View>
          )) : <EmptyState title="Nothing sealed yet" body="Seal a field in Customize." />}
        </Card>
      </Group>
      <Group title="Forget old facts after"><Segmented label="Forget old facts after" value={priv.ret} onChange={(ret) => setPriv({ ret })} options={RETENTION as [string, string][]} /></Group>
      <Card className="gap-s1"><Text size="caption" strong tone="label">What an assistant always sees for a sealed field</Text><Text tone="muted">{`"SSN on file, sealed". The label and the fact that it exists, never the value.`}</Text></Card>
    </Page>
  );
}
