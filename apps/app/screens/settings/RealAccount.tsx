// Account and recovery, What my assistants can see, Privacy and sealing and About from the real box. Account is spaces.identity.* (a new recovery code is shown once,
// in this screen's state only); Seeing is agents.list; Privacy lists the sealed fields from records.types; About reads the running version from update.status.
// The sample's PIN switch, defaults and retention have no tool on the box, so they are not here.
import { useCallback, useEffect, useState } from "react";
import { HIDDEN, claimBlocked } from "../shell/rc";
import { Linking, View } from "react-native";
import { Avatar, Banner, Button, Card, Chip, Divider, EmptyState, Row, Text, markRef, showToast, ErrorState, LoadingState } from "@vyre/ui";
import { Group, Page } from "../places/Frame";
import { contacts, codeOf, devices, entryLine, entryTitle, hasCode, identityLine, removable, sealedFields, type Entry, type Identity, type TypeDef } from "./account-model";
import { worksLine, type Agent } from "./agents-model";
import { agentsList, entries as loadEntries, identity as loadIdentity, removeEntry, replaceCode, types as loadTypes } from "./real";
import { useUpdate } from "../../src/state/update";
import { aboutButton, aboutLine, appliedLine } from "./update-model.js";
import { CREDITS } from "./data";

const say = (e: unknown, f = "That did not work.") => (e instanceof Error ? e.message : f);

export function RealAccount() {
  const [id, setId] = useState<Identity | null>(null);
  const [es, setEs] = useState<Entry[] | null>(null);
  const [err, setErr] = useState("");
  const [fresh, setFresh] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { setErr(""); loadIdentity().then(setId).catch((e) => setErr(say(e, "Account did not answer."))); loadEntries().then(setEs).catch(() => setEs([])); }, []);
  useEffect(load, [load]);
  const newCode = () => { setBusy(true); replaceCode().then((r) => { const c = codeOf(r); if (c) setFresh(c); else showToast("A new code was made, but Vyre did not return it."); load(); }).catch((e) => showToast(say(e))).finally(() => setBusy(false)); };
  const remove = (e: Entry) => removeEntry(e.eid).then(() => { showToast(`${entryTitle(e)} is off your list.`); load(); }).catch((x) => showToast(say(x)));
  const ways = es ? devices(es) : [];
  const cons = es ? contacts(es) : [];
  return (
    <Page title="Account and recovery" back="/u/settings">
      {err ? <Card flush><ErrorState title="Account did not load" reason={err} retry={load} /></Card> : null}
      {id?.exists ? <Card><Row lead={<Avatar of={markRef("person", id.label || id.name || "you")} size={40} />} title={id.label || id.name || "You"} sub={identityLine(id)} className="px-0" /></Card> : null}
      {id && !id.exists ? <Card><EmptyState title={claimBlocked() ? HIDDEN.claimTitle : "No Vyre name on this device yet"} body={claimBlocked() ? HIDDEN.claimBody : "Choose your Vyre name during setup."} /></Card> : null}
      {es ? (
        <>
          <Group title="Ways in" note="Any one signs you in. Any one can add or remove the others.">
            <Card flush>
              {ways.length ? ways.map((e, i) => <View key={e.eid}>{i ? <Divider /> : null}<Row lead={<Avatar of={markRef("device", entryTitle(e))} />} title={entryTitle(e)} sub={entryLine(e)} end={e.self ? <Chip tone="ok">This device</Chip> : removable(e) ? <Button kind="holdText" size="sm" label="Remove" onPress={() => remove(e)} /> : undefined} /></View>) : <EmptyState title="No devices on your list" body="Pair a device and it appears here." />}
            </Card>
          </Group>
          <Group title="Recovery">
            <Card className="gap-s3">
              <Text strong>Recovery code</Text>
              {fresh ? (
                <>
                  <Text tone="muted">A new recovery code. Keep it somewhere safe: it is shown only now, and the old one no longer works.</Text>
                  <Card className="bg-surface-1"><Text mono size="title" selectable>{fresh}</Text></Card>
                  <View className="flex-row"><Button size="sm" label="I wrote it down" onPress={() => setFresh(null)} /></View>
                </>
              ) : (
                <>
                  <Text tone="muted">{hasCode(es) ? "A recovery code is on your list. With it you are back in at once if you lose every device." : "You have no recovery code. Make one so you can get back in if you lose every device."}</Text>
                  <View className="flex-row"><Button size="sm" icon="face" label={hasCode(es) ? "Make a new recovery code" : "Make a recovery code"} disabled={busy} onPress={newCode} /></View>
                </>
              )}
            </Card>
          </Group>
          <Group title="Recovery contacts" note="Optional. Two of them approve to bring you back if you lose everything.">
            <Card flush>
              {cons.length ? cons.map((e, i) => <View key={e.eid}>{i ? <Divider /> : null}<Row lead={<Avatar of={markRef("person", entryTitle(e))} />} title={entryTitle(e)} sub={entryLine(e)} end={<Button kind="holdText" size="sm" label="Remove" onPress={() => remove(e)} />} /></View>) : <EmptyState title="No recovery contacts" body="A contact makes an approval key and gives you its public half." />}
            </Card>
          </Group>
        </>
      ) : !err ? <LoadingState rows={3} /> : null}
    </Page>
  );
}

export function RealSeeing() {
  const [list, setList] = useState<Agent[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => { agentsList().then(setList).catch((e) => setErr(say(e, "Assistants did not answer."))); }, []);
  return (
    <Page title="What my assistants can see" back="/u/settings">
      {err ? <Card flush><ErrorState title="Assistants did not load" reason={err} /></Card> : null}
      {list && !list.length ? <Card><EmptyState title="No assistants yet" body="Your assistant and any agents you make appear here, with the projects each works in." /></Card> : null}
      {list && list.length ? <Card flush>{list.map((a, i) => <View key={a.name}>{i ? <Divider /> : null}<Row lead={<Avatar of={markRef(a.kind === "assistant" ? "assistant" : "teammate", a.name)} />} title={a.name} sub={`Works in: ${worksLine(a.projects)}`} /></View>)}</Card> : null}
      <Banner>Sealed fields stay hidden from every assistant. That includes yours and anyone acting for you. A space's admins decide what is sealed.</Banner>
    </Page>
  );
}

export function RealPrivacy() {
  const [ts, setTs] = useState<TypeDef[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => { loadTypes().then(setTs).catch((e) => setErr(say(e, "Types did not answer."))); }, []);
  const sealed = ts ? sealedFields(ts) : [];
  return (
    <Page title="Privacy and sealing" back="/u/settings">
      {err ? <Card flush><ErrorState title="Types did not load" reason={err} /></Card> : null}
      {ts ? (
        <Group title="Sealed fields">
          <Card flush>
            {sealed.length ? sealed.map((s, i) => <View key={s.type + s.field}>{i ? <Divider /> : null}<Row lead={<Chip tone="sealed" icon="vault">Sealed</Chip>} title={`${s.typeLabel}, ${s.label}`} sub="Hidden from every assistant. They see it as on file, sealed." /></View>) : <EmptyState title="Nothing sealed yet" body="Seal a field in Customize." />}
          </Card>
        </Group>
      ) : !err ? <LoadingState rows={3} /> : null}
      <Card className="gap-s1"><Text size="caption" strong tone="label">What an assistant always sees for a sealed field</Text><Text tone="muted">{'"SSN on file, sealed". The label and the fact that it exists, never the value.'}</Text></Card>
    </Page>
  );
}

/** About: the version the box is running, and the open-source credits. */
export function RealAbout() {
  const { status, busy, check, apply } = useUpdate();
  const v = status ? status.current : null;
  const button = aboutButton(status);
  const run = () => {
    if (!button) return;
    const job = button.action === "apply" ? apply().then((r) => showToast(appliedLine(r))) : check().then(() => undefined);
    job.catch((e) => showToast(say(e)));
  };
  return (
    <Page title="About Vyre" sub={v ? `Version ${v}.` : undefined} back="/u/settings">
      {status ? (
        <Card className="gap-s2">
          <Text tone="muted">{aboutLine(status)}</Text>
          {button ? <View className="flex-row"><Button label={busy ? "Working" : button.label} disabled={busy} onPress={run} /></View> : null}
        </Card>
      ) : null}
      <Group title="Open-source credits">
        <Card flush>{CREDITS.map((c, i) => <View key={c.name}>{i ? <Divider /> : null}<Row title={<Text strong>{c.name}</Text>} sub={<Text size="caption" tone="label">{c.line}</Text>} {...(c.href ? { onPress: () => void Linking.openURL(c.href as string) } : {})} /></View>)}</Card>
      </Group>
      <Text size="caption" tone="label">Vyre itself is Apache 2.0.</Text>
    </Page>
  );
}
