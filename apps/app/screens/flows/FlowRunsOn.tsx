// A Flow's "Runs on": which of your OWN AI accounts its AI steps use (a subscription sign-in or a key). Only your own accounts are listed (sessions.accounts.list answers only yours); saving writes a new version the box checks: only the Flow's
// maker, or the owner for themselves, may change it, and only to their own account (kernel/flows/runs-as.js). The new version is approved like any other.
import { useEffect, useState } from "react";
import { View } from "react-native";
import { Button, Card, Chip, Divider, Row, Text, showToast } from "@vyre/ui";
import { Sec } from "../places/Frame";
import { callT } from "../../src/real/call-tool";
import { defineReal } from "./builder-source";
import { choiceKind, runsOnChoices, runsOnLine, withRunsOn } from "./runs-on-model.js";

type Choice = { id: string; provider: string; label: string; kind: string };

export function FlowRunsOn({ id, flow, onSaved }: { id: string; flow: unknown; onSaved: () => void }) {
  const [accounts, setAccounts] = useState<unknown[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { void callT<unknown[]>("sessions.accounts.list", {}).then((r) => setAccounts(Array.isArray(r.data) ? r.data : [])); }, []);
  const choices: Choice[] = runsOnChoices(accounts ?? []);
  const current = (flow && typeof flow === "object" ? (flow as { runs_on?: { person?: string; account?: string } }).runs_on : undefined) ?? undefined;
  const pick = async (c: Choice) => {
    setBusy(c.id);
    try { await defineReal(withRunsOn(flow, c), id); showToast("Saved as a new version. Approve it to switch to this account."); onSaved(); }
    catch (e) { showToast(e instanceof Error ? e.message : "That did not save."); }
    finally { setBusy(null); }
  };
  return (
    <Sec title="Runs on">
      <Card flush>
        <Row dense title={runsOnLine(current, choices)} sub="Only the person who made this Flow, or the owner for themselves, changes it, and only to an account of their own." />
        {choices.map((c) => (
          <View key={c.id}>
            <Divider />
            <Row dense title={c.label} sub={choiceKind(c)}
              end={current?.account === c.id ? <Chip tone="ok">In use</Chip> : <Button kind="ghost" size="sm" label={busy === c.id ? "Saving" : "Use this"} disabled={busy !== null} onPress={() => void pick(c)} />} />
          </View>
        ))}
      </Card>
      {accounts && !choices.length ? <Text tone="muted">You have no AI account of your own yet. Connect one in Settings, AI accounts: a subscription (Claude, Codex, Grok) or a key.</Text> : null}
    </Sec>
  );
}
