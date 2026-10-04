// Updates and Notifications from the real box: update.status, update.check and update.apply; push.settings (which kinds reach you, quiet hours) and push.devices.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Banner, Button, Card, Divider, EmptyState, Row, Switch, Text, showToast } from "@vyre/ui";
import { Group, Page } from "../places/Frame";
import { autoLine, checkedLine, howLine, KIND_ROWS, QUIET_DEFAULT, quietLine, updateLine, type PushDevice, type PushSettings, type UpdateStatus } from "./real-model";
import { pushDevices, pushSet, pushSettings, updateApply, updateCheck, updateStatus } from "./real";

const say = (e: unknown, f = "That did not work.") => (e instanceof Error ? e.message : f);

export function RealUpdates() {
  const [s, setS] = useState<UpdateStatus | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { setErr(""); updateStatus().then(setS).catch((e) => setErr(say(e, "Updates did not answer."))); }, []);
  useEffect(load, [load]);
  const check = () => { setBusy(true); updateCheck().then(setS).catch((e) => showToast(say(e))).finally(() => setBusy(false)); };
  const apply = () => { setBusy(true); updateApply().then((r) => { showToast(r.requested === false ? r.reason ?? "Not started." : "Update requested."); load(); }).catch((e) => showToast(say(e))).finally(() => setBusy(false)); };
  return (
    <Page title="Updates" back="/u/settings">
      {err ? <Card flush><EmptyState title="Updates did not answer" body={err} action={{ label: "Try again", onPress: load }} /></Card> : null}
      {s ? (
        <>
          <Card className="gap-s2">
            <Text strong>{`Vyre ${s.current}`}</Text>
            <Text tone="muted">{updateLine(s)}</Text>
            <Text size="caption" tone="label">{`${checkedLine(s.checkedAt, Date.now())} Channel: ${s.channel}.`}</Text>
            {s.notes.length ? <View className="gap-s1 pt-s1">{s.notes.map((n, i) => <Text key={i} size="secondary">{n}</Text>)}</View> : null}
            <View className="flex-row gap-s2 pt-s2">
              <Button size="sm" label={busy ? "Checking" : "Check for updates"} disabled={busy} onPress={check} />
              {s.available && s.canApply ? <Button size="sm" kind="primary" label="Update now" disabled={busy} onPress={apply} /> : null}
            </View>
            {howLine(s) ? <Text size="caption" tone="label">{howLine(s)}</Text> : null}
          </Card>
          <Card className="gap-s1"><Text size="caption" strong tone="label">How updates happen</Text><Text tone="muted">{autoLine(s.auto)}</Text></Card>
          <Card className="gap-s1"><Text size="caption" strong tone="label">Safety</Text><Text tone="muted">Updates are signed. Vyre refuses a release that is unsigned, altered or older.</Text></Card>
        </>
      ) : !err ? <Card flush><EmptyState title="Loading" body="Asking your Vyre." /></Card> : null}
    </Page>
  );
}

export function RealNotifications() {
  const [s, setS] = useState<PushSettings | null>(null);
  const [devs, setDevs] = useState<PushDevice[] | null>(null);
  const [err, setErr] = useState("");
  const load = useCallback(() => { setErr(""); pushSettings().then(setS).catch((e) => setErr(say(e, "Notifications did not answer."))); pushDevices().then(setDevs).catch(() => setDevs([])); }, []);
  useEffect(load, [load]);
  const kind = (k: string, on: boolean) => pushSet({ kinds: { [k]: on } }).then(setS).catch((e) => showToast(say(e)));
  const quiet = (on: boolean) => pushSet({ quiet: on ? QUIET_DEFAULT : null }).then(setS).catch((e) => showToast(say(e)));
  return (
    <Page title="Notifications" sub="What can reach you, and when." back="/u/settings">
      {err ? <Card flush><EmptyState title="Notifications did not answer" body={err} action={{ label: "Try again", onPress: load }} /></Card> : null}
      {s ? (
        <>
          <Card flush>
            {KIND_ROWS.map(([k, t, sub], i) => <View key={k}>{i ? <Divider /> : null}<Row title={t} sub={sub} end={<Switch label={t} on={!!s.kinds[k]} onChange={(v) => kind(k, v)} />} /></View>)}
          </Card>
          <Card flush>
            <Row title="Quiet hours" sub={quietLine(s.quiet) + (s.quiet_now ? " Quiet now." : "")} end={<Switch label="Quiet hours" on={!!s.quiet} onChange={quiet} />} />
          </Card>
          <Group title="Devices that get notifications">
            <Card flush>
              {devs && devs.length ? devs.map((d, i) => <View key={d.device}>{i ? <Divider /> : null}<Row dense title={d.label || d.device} sub={`${d.service}${d.fails ? `, ${d.fails} failed` : ""}`} /></View>) : <EmptyState title={devs ? "No device yet" : "Loading"} body={devs ? "A phone or browser that turns notifications on appears here." : "Asking your Vyre."} />}
            </Card>
          </Group>
          <Banner>A notification never carries content. It is a generic line and an id. The details open inside Vyre.</Banner>
        </>
      ) : !err ? <Card flush><EmptyState title="Loading" body="Asking your Vyre." /></Card> : null}
    </Page>
  );
}
