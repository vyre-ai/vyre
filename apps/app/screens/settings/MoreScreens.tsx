import { View } from "react-native";
import { useRouter } from "expo-router";
import { Banner, Button, Card, Divider, Row, Segmented, Switch, Text, allowsMock, showToast } from "@vyre/ui";
import { RealNotifications, RealUpdates } from "./RealMore";
import { Group, Page } from "../places/Frame";
import { CREDITS, VERSION } from "./data";
import { NOTIFY_ROWS } from "./logic.js";
import { useSettings } from "./state";

function SampleNotificationsScreen() {
  const { notify, setNotify } = useSettings();
  return (
    <Page title="Notifications" sub="What can reach you, and when." back="/u/settings">
      <Card flush>
        {NOTIFY_ROWS.map(([k, t, sub], i) => <View key={k}>{i ? <Divider /> : null}<Row title={t} sub={sub} end={<Switch label={t} on={!!notify[k]} onChange={(v) => setNotify(k, v)} />} /></View>)}
      </Card>
      <Banner>A notification never carries content. It is a generic line and an id. The details open inside Vyre.</Banner>
    </Page>
  );
}

function SampleUpdatesScreen() {
  const router = useRouter();
  const { upd, setUpd } = useSettings();
  return (
    <Page title="Updates" back="/u/settings">
      <Card className="gap-s2">
        <Text strong>{`Vyre ${VERSION}`}</Text>
        <Text tone="muted">{upd.checked ? "You are up to date. Checked just now." : "Last checked this morning."}</Text>
        <View className="flex-row"><Button size="sm" label="Check for updates" onPress={() => { setUpd({ checked: true }); showToast("You are up to date."); }} /></View>
      </Card>
      <Card><Row title="Update automatically" sub="At night, one server at a time. Nothing is removed without your click." end={<Switch label="Update automatically" on={upd.auto} onChange={(auto) => setUpd({ auto })} />} /></Card>
      <Group title="Channel"><Segmented label="Channel" value={upd.channel} onChange={(channel) => setUpd({ channel })} options={[["stable", "Stable"], ["preview", "Preview"]]} /></Group>
      <Card className="gap-s1"><Text size="caption" strong tone="label">Safety</Text><Text tone="muted">Updates are signed. Vyre refuses a release that is unsigned, altered or older.</Text></Card>
      <View className="flex-row"><Button kind="ghost" size="sm" label="Kit updates: 1 available" onPress={() => router.push("/u/kits" as never)} /></View>
    </Page>
  );
}

export function AboutScreen() {
  return (
    <Page title="About Vyre" sub={`Version ${VERSION}.`} back="/u/settings">
      <Group title="Open-source credits">
        <Card flush>{CREDITS.map((c, i) => <View key={c.name}>{i ? <Divider /> : null}<Row title={<Text strong>{c.name}</Text>} sub={<Text size="caption" tone="label">{c.line}</Text>} /></View>)}</Card>
      </Group>
      <Text size="caption" tone="label">Vyre itself is Apache 2.0.</Text>
    </Page>
  );
}

/** The sample page in a mock build; the box's own settings everywhere else. */
export const NotificationsScreen = () => (allowsMock() ? <SampleNotificationsScreen /> : <RealNotifications />);
export const UpdatesScreen = () => (allowsMock() ? <SampleUpdatesScreen /> : <RealUpdates />);
