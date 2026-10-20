// Account and recovery, What my assistants can see, Privacy and sealing and About from the real box. Account is spaces.identity.* (a new recovery code is shown once,
// in this screen's state only); Seeing is agents.list; Privacy lists the sealed fields from records.types; About reads the running version from update.status.
// The sample's PIN switch, defaults and retention have no tool on the box, so they are not here.
import { useCallback, useEffect, useState } from "react";
import { ServerLine } from "./ServerLine";
import { HIDDEN, claimBlocked } from "../shell/rc";
import { View } from "react-native";
import { Avatar, Banner, Button, Card, Chip, Divider, EmptyState, PasswordField, Row, Segmented, Text, markRef, showToast, ErrorState, LoadingState } from "@vyre/ui";
import { AboutCard } from "./AboutCard";
import { Group, Page } from "../places/Frame";
import { GithubCard } from "./GithubCard";
import { contacts, codeOf, devices, entryLine, entryTitle, hasCode, READ_ONLY_LINE, removable, sealedFields, approvalsLine, type Entry, type Identity, type TypeDef } from "./account-model";
import { worksLine, type Agent } from "./agents-model";
import { agentsList, entries as loadEntries, identity as loadIdentity, chatSetupProblem, listingProblem, needsPasswordForCode, removeEntry, retryChatSetup, retryListing, replaceCode, types as loadTypes } from "./real";
import { listingLine } from "./account-read.js";
import { useUpdate } from "../../src/state/update";
import { aboutButton, aboutLine, appliedLine, askLine } from "./update-model.js";
import { CREDITS } from "./data";
import { LOCK_CHOICES } from "../../src/shell/lock-gate.js";
import { lockChanged, readLockMinutes, writeLockMinutes } from "../../src/shell/lock-setting";
import { lockIdentity } from "../unlock/real.js";
import { callT } from "../../src/real/call-tool";
import { openExternal } from "../../src/shell/open-external";
import { useKept } from "../../src/state/kept";
import { LabsSwitch } from "./labs";

const say = (e: unknown, f = "That did not work.") => (e instanceof Error ? e.message : f);

export function RealAccount() {
  const kept = useKept<{ id: Identity; es: Entry[] }>("account", async () => { const [id, es] = await Promise.all([loadIdentity(), loadEntries().catch(() => [] as Entry[])]); return { id, es }; }, "Account did not answer.");
  const id = kept.data?.id ?? null;
  const es = kept.data?.es ?? null;
  const err = kept.err;
  const [fresh, setFresh] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pw, setPw] = useState("");
  const [chatProblem, setChatProblem] = useState("");
  const [listing, setListing] = useState("");
  const [listingBusy, setListingBusy] = useState(false);
  const [autoLock, setAutoLock] = useState("15");
  useEffect(() => { void readLockMinutes().then((m) => setAutoLock(String(m))); }, []);
  const chooseLock = (v: string) => { setAutoLock(v); void writeLockMinutes(v); };
  const lockNow = () => { void lockIdentity().then((r) => { if (r.ok) lockChanged(); else showToast(r.message); }); };
  const load = useCallback(() => { kept.reload(); void chatSetupProblem().then(setChatProblem).catch(() => {}); void listingProblem().then(setListing).catch(() => {}); }, [kept.reload]);
  useEffect(load, [load]);
  const newCode = () => { setBusy(true); replaceCode(pw).then((r) => { const c = codeOf(r); setPw(""); if (c) setFresh(c); else showToast("A new code was made, but Vyre did not return it."); load(); }).catch((e) => showToast(say(e))).finally(() => setBusy(false)); };
  const remove = (e: Entry) => removeEntry(e.eid).then(() => { showToast(`${entryTitle(e)} is off your list.`); load(); }).catch((x) => showToast(say(x)));
  const ro = id?.readOnly === true;
  const ways = es ? devices(es) : [];
  const cons = es ? contacts(es) : [];
  return (
    <Page title="Sign-in and recovery" back="/u/settings">
      {err ? <Card flush><ErrorState title="Account did not load" reason={err} retry={load} /></Card> : null}
      {chatProblem ? <Banner icon="refresh"><View className="flex-row flex-wrap items-center gap-s3"><View className="min-w-0 flex-1 gap-s1"><Text>Private chats are not finished setting up on this computer.</Text><Text size="caption" tone="label">{chatProblem}</Text></View><Button size="sm" kind="primary" label="Fix it" onPress={() => void retryChatSetup().then((p) => { setChatProblem(p); load(); }).catch((e) => setChatProblem(say(e)))} /></View></Banner> : null}
      {listing ? <Banner icon="refresh"><View className="gap-s2"><Text tone="warn">{listingLine(listing)}</Text><View className="self-start"><Button size="sm" label={listingBusy ? "Trying" : "Retry"} disabled={listingBusy} onPress={() => { setListingBusy(true); void retryListing().then((p) => { setListing(p); if (!p) showToast("Your server is on your Space's address. It goes live within a few minutes."); }).catch((e) => setListing(say(e))).finally(() => setListingBusy(false)); }} /></View></View></Banner> : null}
      {id?.exists ? <Card><Row lead={<Avatar of={markRef("person", id.name || "you")} size={40} />} title={id.name || "Your username"} sub="Your username and password are the same everywhere." className="px-0" /></Card> : null}
      {id?.readOnly ? <Banner><Text>{READ_ONLY_LINE}</Text></Banner> : null}
      {id && !id.exists ? <Card><EmptyState title={claimBlocked() ? HIDDEN.claimTitle : "No Vyre name on this device yet"} body={claimBlocked() ? HIDDEN.claimBody : "Choose your Vyre name during setup."} /></Card> : null}
      {es ? (
        <>
          <Group title="Ways in" note="Any one signs you in. Any one can add or remove the others.">
            <Card flush>
              {ways.length ? ways.map((e, i) => <View key={e.eid}>{i ? <Divider /> : null}<Row lead={<Avatar of={markRef("device", entryTitle(e))} />} title={entryTitle(e)} sub={entryLine(e)} end={e.self ? <Chip tone="ok">This device</Chip> : removable(e) && !ro ? <Button kind="holdText" size="sm" label="Remove" onPress={() => remove(e)} /> : undefined} /></View>) : <EmptyState title="No devices on your list" body="Pair a device and it appears here." />}
            </Card>
          </Group>
          <GithubCard />
          <Group title="Lock" note="Locking forgets your unlocked keys on this device. The password opens them again.">
            <Card className="gap-s3">
              <Segmented label="Lock after" value={autoLock} onChange={chooseLock} options={LOCK_CHOICES as unknown as [string, string][]} />
              <View className="flex-row"><Button size="sm" icon="lock" label="Lock now" onPress={lockNow} /></View>
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
                  {ro ? null : needsPasswordForCode() ? <PasswordField label="Your password, to make the code" value={pw} onChangeText={setPw} /> : null}
                  {ro ? null : <View className="flex-row"><Button size="sm" icon="face" label={hasCode(es) ? "Make a new recovery code" : "Make a recovery code"} disabled={busy || (needsPasswordForCode() && !pw)} onPress={newCode} /></View>}
                </>
              )}
            </Card>
          </Group>
          <Group title="Recovery contacts" note="Optional. Two of them approve to bring you back if you lose everything.">
            <Card flush>
              {cons.length ? cons.map((e, i) => <View key={e.eid}>{i ? <Divider /> : null}<Row lead={<Avatar of={markRef("person", entryTitle(e))} />} title={entryTitle(e)} sub={entryLine(e)} end={ro ? undefined : <Button kind="holdText" size="sm" label="Remove" onPress={() => remove(e)} />} /></View>) : <EmptyState title="No recovery contacts" body="A contact makes an approval key and gives you its public half." />}
            </Card>
          </Group>
        </>
      ) : !err ? <LoadingState rows={3} /> : null}
    </Page>
  );
}

export function RealSeeing() {
  const k = useKept<Agent[]>("agents", agentsList as () => Promise<Agent[]>, "Agents did not answer.");
  const list = k.data;
  const err = k.err;
  return (
    <Page title="What my agents can see" back="/u/settings">
      {err ? <Card flush><ErrorState title="Agents did not load" reason={err} retry={k.reload} /></Card> : null}
      {list && !list.length ? <Card><EmptyState title="No agents yet" body="Your agent and any agents you make appear here, with the projects each works in." /></Card> : null}
      {list && list.length ? <Card flush>{list.map((a, i) => <View key={a.name}>{i ? <Divider /> : null}<Row lead={<Avatar of={markRef("agent", a.name, undefined, (a as { look?: string }).look || undefined)} />} title={a.name} sub={`Works in: ${worksLine(a.projects)}`} /></View>)}</Card> : null}
      <Banner>Sealed fields stay hidden from every agent. That includes yours and anyone acting for you. A space's admins decide what is sealed.</Banner>
    </Page>
  );
}

export function RealPrivacy() {
  const kt = useKept<TypeDef[]>("types", loadTypes, "Types did not answer.");
  const ts = kt.data;
  const err = kt.err;
  const [approvals, setApprovals] = useState<string | null>(null);
  useEffect(() => { callT("presence.keys", {}).then((r) => setApprovals(approvalsLine(r.data))).catch(() => setApprovals(null)); }, []);
  const sealed = ts ? sealedFields(ts) : [];
  return (
    <Page title="Privacy and sealing" back="/u/settings">
      {approvals ? <Banner>{approvals}</Banner> : null}
      {err ? <Card flush><ErrorState title="Types did not load" reason={err} retry={kt.reload} /></Card> : null}
      {ts ? (
        <Group title="Sealed fields">
          <Card flush>
            {sealed.length ? sealed.map((s, i) => <View key={s.type + s.field}>{i ? <Divider /> : null}<Row lead={<Chip tone="sealed" icon="vault">Sealed</Chip>} title={`${s.typeLabel}, ${s.label}`} sub="Hidden from every agent. They see it as on file, sealed." /></View>) : <EmptyState title="Nothing sealed yet" body="Seal a field in Customize." />}
          </Card>
        </Group>
      ) : !err ? <LoadingState rows={3} /> : null}
      <Card className="gap-s1"><Text size="caption" strong tone="label">What an agent always sees for a sealed field</Text><Text tone="muted">{'"SSN on file, sealed". The label and the fact that it exists, never the value.'}</Text></Card>
    </Page>
  );
}

/** About: the version the box is running, and the open-source credits. */
export function RealAbout() {
  const { status, busy, asking, ask, cancel, check, apply } = useUpdate();
  const v = status ? status.current : null;
  const button = aboutButton(status);
  const run = () => {
    if (!button) return;
    if (button.action === "apply") { ask(); return; }
    check().catch((e) => showToast(say(e)));
  };
  const yes = () => {
    apply().then((r) => showToast(appliedLine(r))).catch((e) => showToast(say(e)));
  };
  return (
    <Page title="About Vyre" back="/u/settings">
      {status ? (
        <Card className="gap-s2">
          <ServerLine />
          <Text tone="muted">{aboutLine(status)}</Text>
          {asking && status.available ? <Text>{askLine(status)}</Text> : null}
          {asking && status.available ? <View className="flex-row gap-s2"><Button label={busy ? "Working" : "Yes, update"} disabled={busy} onPress={yes} /><Button label="Not now" disabled={busy} onPress={cancel} /></View>
            : button ? <View className="flex-row"><Button label={busy ? "Working" : button.label} disabled={busy} onPress={run} /></View> : null}
        </Card>
      ) : null}
      <AboutCard version={v} />
      <Group title="Open-source credits">
        <Card flush>{CREDITS.map((c, i) => <View key={c.name}>{i ? <Divider /> : null}<Row title={<Text strong>{c.name}</Text>} sub={<Text size="caption" tone="label">{c.line}</Text>} {...(c.href ? { onPress: () => void openExternal(c.href as string) } : {})} /></View>)}</Card>
      </Group>
      <Text size="caption" tone="label">Vyre itself is Apache 2.0.</Text>
      <LabsSwitch />
    </Page>
  );
}
