// AI accounts beyond Claude: every account sessions can run on (Codex, Grok, ...), who each is signed in as, which is the default, and a way to add one with the provider's own sign-in
// (the Deck's settings-accounts.js, ported). The sign-in is the provider's: Vyre shows its link and code and never sees a password or token.
import { useCallback, useEffect, useRef, useState } from "react";
import { Linking, View } from "react-native";
import { Button, Card, Chip, Divider, ErrorState, Field, LoadingState, Segmented, Text, showToast } from "@vyre/ui";
import { ADDABLE, canMakeDefault, canSignIn, keepFollowing, providerName, safeUrl, stateWord, type Account, type Flow } from "./accounts-model";
import { accounts } from "./accounts";

const say = (e: unknown, f = "That did not go through.") => ((e as { code?: string })?.code === "not_found" ? "This box has no AI accounts yet." : e instanceof Error && e.message ? e.message : f);

export function AccountsCard() {
  const [rows, setRows] = useState<Account[] | null>(null);
  const [err, setErr] = useState("");
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState("");
  const [confirming, setConfirming] = useState("");
  const [adding, setAdding] = useState(false);
  const [provider, setProvider] = useState(ADDABLE[0]);
  const [label, setLabel] = useState("");
  const [flow, setFlow] = useState<Flow | null>(null);
  const [code, setCode] = useState("");
  const run = useRef(0);
  const load = useCallback(() => { setErr(""); accounts.list().then(setRows).catch((e) => { setRows([]); setErr(say(e, "Your AI accounts could not be read.")); }); }, []);
  useEffect(() => { load(); return () => { run.current++; }; }, [load]);

  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id); setProblem("");
    try { await fn(); setConfirming(""); load(); } catch (e) { setProblem(say(e)); } finally { setBusy(""); }
  };
  /** Follow a sign-in until it ends. The box holds each status call open for a while, so this is not a tight loop; it ends with the card, a Cancel, or an end state. */
  const follow = async (id: string, prov: string, mine: number) => {
    while (run.current === mine) {
      let f: Flow;
      try { f = await accounts.follow(id, prov); } catch (e) { if (run.current === mine) { setFlow(null); setProblem(say(e)); } return; }
      if (run.current !== mine) return;
      setFlow(f);
      if (f.step === "done") { setFlow(null); setAdding(false); load(); return; }
      if (!keepFollowing(f)) return;
    }
  };
  const start = async (prov: string, name = "", account = "") => {
    setProblem(""); const mine = ++run.current;
    setFlow({ id: "", step: "waiting", provider: prov });
    try {
      const f = await accounts.start(prov, name, account);
      if (run.current !== mine) return;
      setFlow(f);
      if (f.id && keepFollowing(f)) void follow(f.id, prov, mine);
    } catch (e) { if (run.current === mine) { setFlow(null); setProblem(say(e)); } }
  };
  const cancel = () => { run.current++; setFlow(null); setAdding(false); setProblem(""); setCode(""); load(); };
  const submit = async (f: Flow) => {
    try { await accounts.paste(f.id, code); setProblem(""); setCode(""); setFlow({ ...f, step: "waiting" }); void follow(f.id, f.provider, run.current); }
    catch (e) { setProblem(say(e, "That did not look like the code.")); }
  };

  const name = flow ? providerName(flow.provider) : "";
  return (
    <Card className="gap-s3">
      <Text strong>Other AI accounts</Text>
      <Text size="caption" tone="label">The accounts chats can run on. Each signs in with its own provider, and Vyre never sees the password or token.</Text>
      {problem ? <Text size="caption" tone="warn">{problem}</Text> : null}
      {rows === null ? <LoadingState rows={2} /> : null}
      {err ? <ErrorState title="AI accounts did not load" reason={err} retry={load} /> : null}
      {rows && !err && !rows.length ? <Text tone="muted">No AI accounts yet.</Text> : null}
      {rows && rows.length ? (
        <View>
          {rows.map((a, i) => (
            <View key={a.id}>
              {i ? <Divider /> : null}
              <View className="gap-s2 py-s2">
                <View className="flex-row flex-wrap items-center gap-s2"><Text strong>{providerName(a.provider)}</Text><Text tone="muted">{a.label}</Text>{a.isDefault ? <Chip>Default</Chip> : null}</View>
                <Text size="caption" tone="label">{stateWord(a)}</Text>
                {a.provider === "grok" && a.privacyLabel ? <Text size="caption" tone="muted">{`${a.privacyLabel} ${a.privacyNote}`.trim()}</Text> : null}
                {confirming === a.id ? (
                  <View className="gap-s2">
                    <Text size="caption">{`Remove ${a.label}? Sessions already on it keep running; the next one asks for another account.`}</Text>
                    <View className="flex-row flex-wrap gap-s2">
                      <Button size="sm" label="Remove" disabled={busy === a.id} onPress={() => void act(a.id, () => accounts.remove(a.id))} />
                      <Button kind="ghost" size="sm" label="Keep" onPress={() => setConfirming("")} />
                    </View>
                  </View>
                ) : (
                  <View className="flex-row flex-wrap gap-s2">
                    {canSignIn(a) ? <Button size="sm" label="Sign in" onPress={() => void start(a.provider, "", a.id)} /> : null}
                    {canMakeDefault(a, rows) ? <Button kind="ghost" size="sm" label="Make default" disabled={busy === a.id} onPress={() => void act(a.id, () => accounts.makeDefault(a.id))} /> : null}
                    {a.provider === "grok" && a.privacy !== null ? <Button kind="ghost" size="sm" label={a.privacy ? "I turned privacy mode off" : "I turned privacy mode on"} disabled={busy === a.id} onPress={() => void act(a.id, () => accounts.setPrivacy(a.id, !a.privacy))} /> : null}
                    {a.synthetic ? null : <Button kind="ghost" size="sm" label="Remove" onPress={() => setConfirming(a.id)} />}
                  </View>
                )}
              </View>
            </View>
          ))}
        </View>
      ) : null}
      {flow ? (
        flow.step === "failed" ? (
          <View className="gap-s2">
            <Text size="caption" tone="warn">{`Signing in to ${name} did not finish. ${flow.message || ""}`.trim()}</Text>
            <View className="self-start"><Button kind="ghost" size="sm" label="Close" onPress={cancel} /></View>
          </View>
        ) : (
          <View className="gap-s2">
            <Text>{flow.url ? `Open this page, sign in to ${name}, and approve.` : `Starting the ${name} sign-in.`}</Text>
            {flow.url && safeUrl(flow.url) ? <View className="self-start"><Button size="sm" label="Open the sign-in" onPress={() => void Linking.openURL(flow.url as string)} /></View> : null}
            {flow.code ? <Text mono>{`Code: ${flow.code}`}</Text> : null}
            {flow.step === "url" ? (
              <View className="gap-s2">
                <Field name="The code the page showed" value={code} onChangeText={setCode} placeholder="Paste the code here" />
                <View className="self-start"><Button size="sm" label="Continue" disabled={!code.trim()} onPress={() => void submit(flow)} /></View>
              </View>
            ) : <Text size="caption" tone="muted">Waiting for you to approve it.</Text>}
            <View className="self-start"><Button kind="ghost" size="sm" label="Cancel" onPress={cancel} /></View>
          </View>
        )
      ) : adding ? (
        <View className="gap-s2">
          <Segmented label="Which AI" value={provider} onChange={setProvider} options={ADDABLE.map((p) => [p, providerName(p)] as [string, string])} />
          <Field name="A name for it" value={label} onChangeText={setLabel} placeholder="A name, like work (optional)" />
          <View className="flex-row flex-wrap gap-s2">
            <Button size="sm" label="Sign in" onPress={() => void start(provider, label.trim())} />
            <Button kind="ghost" size="sm" label="Cancel" onPress={cancel} />
          </View>
        </View>
      ) : (
        <View className="self-start"><Button size="sm" label="Add an account" onPress={() => setAdding(true)} /></View>
      )}
    </Card>
  );
}
