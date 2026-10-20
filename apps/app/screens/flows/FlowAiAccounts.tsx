// A Flow's "AI accounts" tab, shown only when the Flow has an AI step: the main account its AI steps run on and an optional fallback, each one of YOUR OWN accounts (sign-ins and keys) with a model
// from that account's own list. Saving writes a new version the box checks: only the Flow's maker, or the owner for themselves, may change it, and only to their own accounts (kernel/flows/runs-as.js).
// The fallback answers when the main one is out of credits, rate limited, signed out or not answering (core/daemon/flow-model.js).
import { useEffect, useState } from "react";
import { View } from "react-native";
import { Button, Card, ProviderBadge, Select, Text, showToast } from "@vyre/ui";
import { Sec } from "../places/Frame";
import { callT } from "../../src/real/call-tool";
import { modelRows } from "../../src/chat/agent-new-model.js";
import { defineReal } from "./builder-source";
import { AI_ACCOUNTS_LINE, aiChoices, choiceKind, pickWords, storedAccounts, withAccounts } from "./runs-on-model.js";

type Choice = { id: string; provider: string; label: string; kind: string };
type Pick = { account: string; provider?: string; model?: string };
const DEFAULT_MODEL = "";

/** One account and its model, picked from the viewer's own. */
function AccountPick({ title, choices, models, value, onChange, optional }: { title: string; choices: Choice[]; models: Record<string, { id: string; label: string }[]>; value: Pick | null; onChange: (p: Pick | null) => void; optional?: boolean }) {
  const acct = value ? choices.find((c) => c.id === value.account) : undefined;
  const offered = value ? models[value.account] ?? [] : [];
  return (
    <View className="gap-s2">
      <View className="flex-row items-center gap-s2">{acct ? <ProviderBadge provider={acct.provider} size={20} /> : null}<Text strong>{title}</Text></View>
      <Select label="Account" value={value ? value.account : ""} placeholder={optional ? "No fallback" : "Choose an account"}
        options={[...(optional ? [["", "No fallback"] as [string, string]] : []), ...choices.map((c) => [c.id, `${c.label} (${choiceKind(c)})`] as [string, string])]}
        onChange={(id) => { const c = choices.find((x) => x.id === id); onChange(c ? { account: c.id, provider: c.provider } : null); }} />
      {value ? <Select label="Model" value={value.model ?? DEFAULT_MODEL} options={[[DEFAULT_MODEL, "The account's default"], ...offered.map((m) => [m.id, m.label] as [string, string])]}
        onChange={(model) => onChange(model ? { ...value, model } : { account: value.account, ...(value.provider ? { provider: value.provider } : {}) })} /> : null}
    </View>
  );
}

export function FlowAiAccounts({ id, flow, onSaved }: { id: string; flow: unknown; onSaved: () => void }) {
  const [choices, setChoices] = useState<Choice[] | null>(null);
  const [models, setModels] = useState<Record<string, { id: string; label: string }[]>>({});
  const stored = storedAccounts(flow);
  const [main, setMain] = useState<Pick | null>(stored.main);
  const [fallback, setFallback] = useState<Pick | null>(stored.fallback);
  const [busy, setBusy] = useState(false);
  useEffect(() => { const s = storedAccounts(flow); setMain(s.main); setFallback(s.fallback); }, [flow]);
  useEffect(() => {
    void callT<unknown>("sessions.accounts.list", {}).then(async (r) => {
      const c = aiChoices(r.data);
      setChoices(c);
      // each account's own model list (sessions.accounts.models); one that cannot be read offers its default only
      const lists = await Promise.all(c.slice(0, 12).map(async (a) => { const m = await callT<unknown>("sessions.accounts.models", { account: a.id }); return [a.id, m.error ? [] : modelRows(m.data)] as const; }));
      setModels(Object.fromEntries(lists));
    });
  }, []);
  const save = async () => {
    if (!main) return;
    setBusy(true);
    try { await defineReal(withAccounts(flow, main, fallback), id); showToast("Saved as a new version. Approve it to use these accounts."); onSaved(); }
    catch (e) { showToast(e instanceof Error ? e.message : "That did not save."); }
    finally { setBusy(false); }
  };
  const list = choices ?? [];
  return (
    <Sec title="AI accounts">
      <Card>
        <View className="gap-s4">
          <Text>{AI_ACCOUNTS_LINE}</Text>
          <Text size="caption" tone="label">{`Now: ${pickWords(stored.main, list)}${stored.fallback ? `, then ${pickWords(stored.fallback, list)}` : ""}.`}</Text>
          {choices && !list.length ? <Text tone="muted">You have no AI account yet. Add one under Settings, AI accounts.</Text> : null}
          {list.length ? <AccountPick title="Main" choices={list} models={models} value={main} onChange={setMain} /> : null}
          {list.length ? <AccountPick title="Fallback, if the main one is out of credits or not answering" choices={list.filter((c) => !main || c.id !== main.account)} models={models} value={fallback} onChange={setFallback} optional /> : null}
          {list.length ? <View className="self-start"><Button kind="primary" size="sm" label={busy ? "Saving" : "Save"} disabled={busy || !main} onPress={() => void save()} /></View> : null}
          <Text size="caption" tone="label">Only the person who made this Flow, or the owner for themselves, changes these, and only to accounts of their own.</Text>
        </View>
      </Card>
    </Sec>
  );
}
