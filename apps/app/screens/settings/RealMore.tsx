// Updates and Notifications from the real box: update.status, update.check and update.apply; push.settings (which kinds reach you, quiet hours) and push.devices.
import { useState } from "react";
import { ServerLine } from "./ServerLine";
import { View } from "react-native";
import { Banner, Button, Card, Divider, EmptyState, Row, Switch, Text, showToast, ErrorState, LoadingState } from "@vyre/ui";
import { Group, Page } from "../places/Frame";
import { autoLine, checkedLine, howLine, KIND_ROWS, noteLines, QUIET_DEFAULT, quietLine, updateLine, type PushDevice, type PushSettings, type UpdateStatus } from "./real-model";
import { pushDevices, pushSet, pushSettings, updateApply, updateCheck, updateStatus } from "./real";
import { askLine } from "./update-model.js";
import { BackupsSection } from "./BackupsScreen";
import { shell } from "../../src/shell/shell";
import { useKept } from "../../src/state/kept";
import { AppUpdateCard } from "../now/AppUpdateCard";

const say = (e: unknown, f = "That did not work.") => (e instanceof Error ? e.message : f);

export function RealUpdates() {
  const ku = useKept<UpdateStatus>("updates", updateStatus, "Updates did not answer.");
  const s = ku.data;
  const err = ku.err;
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const load = ku.reload;
  const check = () => { setBusy(true); updateCheck().then(ku.put).catch((e) => showToast(say(e))).finally(() => setBusy(false)); };
  const apply = () => { setBusy(true); setAsking(false); updateApply().then((r) => { showToast(r.requested === false ? r.reason ?? "Not started." : "Update requested."); load(); }).catch((e) => showToast(say(e))).finally(() => setBusy(false)); };
  return (
    <Page title="Updates and backups" back="/u/settings">
      <ServerLine />
      {shell() ? <AppUpdateCard hint={s?.available ?? null} /> : null}
      {err ? <Card flush><ErrorState title="Updates did not load" reason={err} retry={load} /></Card> : null}
      {s ? (
        <>
          <Card className="gap-s2">
            <Text strong>{`Vyre ${s.current}`}</Text>
            <Text tone="muted">{updateLine(s)}</Text>
            <Text size="caption" tone="label">{`${checkedLine(s.checkedAt, Date.now())} Channel: ${s.channel}.`}</Text>
            {noteLines(s.notes).length ? <View className="gap-s1 pt-s1">{noteLines(s.notes).map((n, i) => <Text key={i} size="secondary">{n}</Text>)}</View> : null}
            <View className="flex-row gap-s2 pt-s2">
              <Button size="sm" label={busy ? "Checking" : "Check for updates"} disabled={busy} onPress={check} />
              {s.available && s.canApply && !asking ? <Button size="sm" kind="primary" label="Update" disabled={busy} onPress={() => setAsking(true)} /> : null}
              {s.available && s.canApply && asking ? <><Button size="sm" kind="primary" label="Yes, update" disabled={busy} onPress={apply} /><Button size="sm" label="Not now" disabled={busy} onPress={() => setAsking(false)} /></> : null}
            </View>
            {s.available && s.canApply && asking ? <Text>{askLine(s as never)}</Text> : null}
            {howLine(s) ? <Text size="caption" tone="label">{howLine(s)}</Text> : null}
          </Card>
          <Card className="gap-s1"><Text size="caption" strong tone="label">How updates happen</Text><Text tone="muted">{autoLine(s.auto)}</Text></Card>
          <Card className="gap-s1"><Text size="caption" strong tone="label">Safety</Text><Text tone="muted">Updates are signed. Vyre refuses a release that is unsigned, altered or older.</Text></Card>
        </>
      ) : !err ? <LoadingState rows={3} /> : null}
      <Group title="Backups"><BackupsSection /></Group>
    </Page>
  );
}

export function RealNotifications() {
  // the settings and the devices are asked together, and a switch moves at once and goes back with the reason if the server refuses
  const kn = useKept<{ s: PushSettings; devs: PushDevice[] }>("notifications", async () => { const [s, devs] = await Promise.all([pushSettings(), pushDevices().catch(() => [] as PushDevice[])]); return { s, devs }; }, "Notifications did not answer.");
  const s = kn.data?.s ?? null;
  const devs = kn.data?.devs ?? null;
  const err = kn.err;
  const load = kn.reload;
  const change = (next: (cur: PushSettings) => PushSettings, send: () => Promise<PushSettings>) => {
    const before = kn.data;
    if (before) kn.put({ ...before, s: next(before.s) });
    send().then((fresh) => kn.put((cur) => (cur ? { ...cur, s: fresh } : cur))).catch((e) => { if (before) kn.put(before); showToast(say(e, "That did not go through.")); });
  };
  const kind = (k: string, on: boolean) => change((cur) => ({ ...cur, kinds: { ...cur.kinds, [k]: on } }), () => pushSet({ kinds: { [k]: on } }));
  const quiet = (on: boolean) => change((cur) => ({ ...cur, quiet: on ? QUIET_DEFAULT : null } as PushSettings), () => pushSet({ quiet: on ? QUIET_DEFAULT : null }));
  return (
    <Page title="Notifications" sub="What can reach you, and when." back="/u/settings">
      {err ? <Card flush><ErrorState title="Notifications did not load" reason={err} retry={load} /></Card> : null}
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
              {devs && devs.length ? devs.map((d, i) => <View key={d.device}>{i ? <Divider /> : null}<Row dense title={d.label || "A device"} sub={`${d.service}${d.fails ? `, ${d.fails} failed` : ""}`} /></View>) : <EmptyState title={devs ? "No device yet" : "Loading"} body={devs ? "A phone or browser that turns notifications on appears here." : "Asking your Vyre."} />}
            </Card>
          </Group>
          <Banner>A notification never carries content. It is a generic line and an id. The details open inside Vyre.</Banner>
        </>
      ) : !err ? <LoadingState rows={3} /> : null}
    </Page>
  );
}
