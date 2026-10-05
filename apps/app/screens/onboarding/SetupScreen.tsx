// Setup after the passkey, in the app: you and your assistant, your computers, your history, then the ending. The Deck's mountSetup, on the app's own parts.
// It reads onboard.status (the box's record, not this screen's memory) and polls it while a step waits on something outside (a computer pairing, a scan).
import { useCallback, useEffect, useRef, useState } from "react";
import { Linking, View } from "react-native";
import { useRouter } from "expo-router";
import { Banner, Button, Card, Chip, Divider, ErrorState, Field, LoadingState, SectionLabel, Text } from "@vyre/ui";
import { Page } from "../places/Frame";
import { computersOf, historyLines, say, stepLabel, viewOf, youInput, type Ending, type Setup, type Status, type StepId, type View as SetupView } from "./model";
import { finish, history, read, retry, skip, you } from "./real";

const POLL_MS = 3000;
type Own = { status: Status; setup: Setup };

export function SetupScreen({ onDone }: { onDone?: () => void } = {}) {
  const router = useRouter();
  const [own, setOwn] = useState<Own | null>(null);
  const [loadError, setLoadError] = useState("");
  const [passed, setPassed] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [add, setAdd] = useState(false);
  const [ending, setEnding] = useState<Ending | null>(null);
  const [checking, setChecking] = useState(false);
  const [name, setName] = useState("");
  const [assistant, setAssistant] = useState("");
  const [typed, setTyped] = useState(false);
  const finishing = useRef(false);

  const load = useCallback(async () => {
    try { const r = await read(); setOwn(r); setLoadError(""); if (!typed && r.setup?.name) setName(r.setup.name); }
    catch (e) { setLoadError(say(e)); }
  }, [typed]);
  useEffect(() => { load(); }, [load]);

  const view: SetupView | null = own ? viewOf(own.status, own.setup, passed) : null;
  // The box's record moves on its own when a computer pairs or a scan ends: ask again while the step is one of those.
  useEffect(() => {
    if (!view || (view.current !== "computers" && view.current !== "history") || busy) return;
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [view?.current, busy, load]);
  // Every step done and the box does not yet say finished: finish it once.
  useEffect(() => {
    if (!view || !own || !view.finished || own.status.finished || ending || finishing.current) return;
    finishing.current = true;
    finish().then((e) => { setEnding(e); onDone?.(); }).catch((e) => setEnding({ name: null, display: null, thread: null, why: say(e) }));
  }, [view?.finished, own, ending, onDone]);

  const act = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError("");
    try { await fn(); } catch (e) { setError(say(e)); }
    setBusy(false);
    await load();
  };
  const hasSetup = Boolean(own?.setup);

  const goName = () => {
    const r = youInput(name, assistant);
    if ("error" in r) { setError(r.error); return; }
    act(() => you(r.name, r.assistant));
  };
  const tryAgain = async () => {
    if (checking) return;
    setChecking(true);
    try { setEnding(await retry()); } catch (e) { setEnding({ name: null, display: null, thread: null, why: say(e) }); }
    setChecking(false);
  };

  return (
    <Page title="Set up Vyre" back="/u/settings">
      {loadError && !own ? <Card flush><ErrorState title="Your server did not answer" reason={loadError} retry={load} /></Card> : null}
      {!own && !loadError ? <LoadingState rows={3} /> : null}
      {view && own ? (
        <>
          <Timeline view={view} />
          {error ? <Banner tone="err">{error}</Banner> : null}
          {view.finished || ending ? <Done ending={ending} checking={checking} retry={tryAgain} open={(t) => router.push(`/session/${encodeURIComponent(t)}` as never)} />
            : view.current === "assistant" ? (
              <Card>
                <Panel view={view} id="assistant" title="You and your assistant" lead="Steps 1 to 7 are done. Tell Vyre your name, and name the assistant that will help you.">
                  <Field label="Your name" name="Your name" value={name} onChangeText={(v) => { setTyped(true); setName(v); }} />
                  <Field label="Your assistant's name" name="Your assistant's name" value={assistant} onChangeText={setAssistant} placeholder={own.status.assistant || "Juno"} />
                  <View className="flex-row"><Button kind="primary" label="Continue" disabled={busy} onPress={goName} /></View>
                </Panel>
              </Card>
            ) : view.current === "computers" ? (
              <Computers view={view} status={own.status} add={add} busy={busy}
                onAdd={() => setAdd(true)} onContinue={() => setPassed((p) => [...p, "computers"])} onSkip={() => act(() => skip("computers", hasSetup))} />
            ) : (
              <HistoryStep view={view} status={own.status} busy={busy} onContinue={() => act(async () => { await history(hasSetup); setPassed((p) => [...p, "history"]); })} onSkip={() => act(() => skip("history", hasSetup))} />
            )}
        </>
      ) : null}
    </Page>
  );
}

function Timeline({ view }: { view: SetupView }) {
  return (
    <Card flush>
      {view.list.map((s, i) => (
        <View key={s.id}>
          {i ? <Divider /> : null}
          <View className="flex-row items-center gap-s3 px-s4 py-s2" accessibilityLabel={`${s.title}, ${s.status === "current" ? "now" : s.status}`}>
            <View className="min-w-0 flex-1"><Text strong={s.status === "current"} tone={s.status === "todo" ? "label" : undefined}>{s.title}</Text></View>
            {s.optional && s.status !== "done" ? <Text size="caption" tone="label">optional</Text> : null}
            {s.status === "done" ? <Chip tone="ok">Done</Chip> : s.status === "skipped" ? <Chip>Skipped</Chip> : s.status === "current" ? <Chip tone="accent">Now</Chip> : null}
          </View>
        </View>
      ))}
    </Card>
  );
}

function Panel({ view, id, title, lead, children }: { view: SetupView; id: StepId; title: string; lead: string; children?: React.ReactNode }) {
  return (
    <View className="gap-s3">
      <SectionLabel first>{stepLabel(view, id)}</SectionLabel>
      <Text size="page" strong>{title}</Text>
      <Text tone="muted">{lead}</Text>
      {children}
    </View>
  );
}

function Computers({ view, status, add, busy, onAdd, onContinue, onSkip }: { view: SetupView; status: Status; add: boolean; busy: boolean; onAdd: () => void; onContinue: () => void; onSkip: () => void }) {
  const { mac, download } = computersOf(status);
  return (
    <Card>
      <Panel view={view} id="computers" title="Your computers" lead="Pair a Mac or a Windows PC, and get Vyre Lumen on it. Your agents can then work with that computer.">
        {mac ? <View className="gap-s1"><Text strong>{mac.name}</Text><Text size="caption" tone="label">Paired</Text></View> : null}
        {!mac && add ? (
          <View className="gap-s2">
            <Text tone="muted">Install Vyre Lumen on the computer and open it. This page notices when it pairs.</Text>
            {download ? <View className="flex-row"><Button kind="secondary" label="Download Vyre Lumen" onPress={() => { Linking.openURL(download).catch(() => {}); }} /></View> : null}
          </View>
        ) : null}
        <View className="flex-row flex-wrap gap-s2">
          {mac ? <Button kind="primary" label="Continue" disabled={busy} onPress={onContinue} />
            : <><Button kind="primary" label="Add a computer" disabled={busy} onPress={onAdd} /><Button kind="ghost" label="Skip for now" disabled={busy} onPress={onSkip} /></>}
        </View>
      </Panel>
    </Card>
  );
}

function HistoryStep({ view, status, busy, onContinue, onSkip }: { view: SetupView; status: Status; busy: boolean; onContinue: () => void; onSkip: () => void }) {
  const h = historyLines(status);
  return (
    <Card>
      <Panel view={view} id="history" title="Your history" lead={h.found}>
        {h.hint ? <Text size="caption" tone="label">{h.hint}</Text> : null}
        <View className="flex-row flex-wrap gap-s2">
          <Button kind="primary" label="Continue" disabled={busy} onPress={onContinue} />
          <Button kind="ghost" label="Skip for now" disabled={busy} onPress={onSkip} />
        </View>
      </Panel>
    </Card>
  );
}

function Done({ ending, checking, retry, open }: { ending: Ending | null; checking: boolean; retry: () => void; open: (thread: string) => void }) {
  const who = ending?.display || ending?.name || "Your assistant";
  return (
    <Card>
      <View className="gap-s3">
        <SectionLabel first>Done</SectionLabel>
        {ending?.why ? (
          <>
            <Text size="page" strong>Setup is finished</Text>
            <Text tone="muted">{`${who} could not start yet.`}</Text>
            <Banner tone="warn">{ending.why}</Banner>
            <View className="flex-row"><Button kind="primary" label="Try again" disabled={checking} onPress={retry} /></View>
          </>
        ) : ending?.thread ? (
          <>
            <Text size="page" strong>{`${who} is ready`}</Text>
            <Text tone="muted">Setup is finished. Your assistant has said hello in its first thread.</Text>
            <View className="flex-row"><Button kind="primary" label={`Open ${who}'s thread`} onPress={() => open(ending.thread as string)} /></View>
          </>
        ) : (
          <>
            <Text size="page" strong>Setup is finished</Text>
            <Text tone="muted">{`${who} is ready when you are.`}</Text>
          </>
        )}
      </View>
    </Card>
  );
}
