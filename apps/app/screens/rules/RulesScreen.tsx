// The space's standing rules: never, drafts only, always ask. The sentence under each is the kernel's own plain-words view. An owner sets and removes a
// rule and accepts or turns down a proposal, each with presence (the box asks, the app's person session answers). Anyone else proposes, and it does
// nothing until an owner accepts it.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Banner, Button, Card, Chip, Divider, EmptyState, Field, Row, Segmented, Sheet, Text, showToast } from "@vyre/ui";
import { Footnote, Frame, Sec } from "../places/Frame";
import { acceptReal, dismissReal, listReal, proposeReal, removeReal, roleReal, setReal } from "./real";
import { KINDS, ROLES, build, groups, proposer, ruleRefusal, type Draft, type Listing } from "./model";

const say = (e: unknown) => ruleRefusal((e as { code?: string }).code, e instanceof Error ? e.message : "");
const BLANK: Draft = { kind: "never", binds: ["assistants"], actions: "", resource: "", approverKind: "role", approver: "owner", label: "" };

export default function RulesScreen() {
  const [data, setData] = useState<Listing | null>(null);
  const [owner, setOwner] = useState(false);
  const [err, setErr] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setErr("");
    listReal().then(setData).catch((e) => setErr(say(e)));
    roleReal().then((r) => setOwner(r === "owner")).catch(() => setOwner(false));
  }, []);
  useEffect(load, [load]);

  const act = (run: () => Promise<unknown>, done: string) => {
    setBusy(true);
    run().then(() => { showToast(done); load(); }).catch((e) => showToast(say(e))).finally(() => setBusy(false));
  };

  const save = () => {
    if (!draft) return;
    const b = build(draft);
    if ("error" in b) { setProblem(b.error); return; }
    setProblem(""); setBusy(true);
    (owner ? setReal(b.rule) : proposeReal(b.rule))
      .then(() => { showToast(owner ? "The rule is in force." : "Proposed. It does nothing until an owner accepts it."); setDraft(null); load(); })
      .catch((e) => setProblem(say(e)))
      .finally(() => setBusy(false));
  };
  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const toggle = (b: "assistants" | "members") => draft && set({ binds: draft.binds.includes(b) ? draft.binds.filter((x) => x !== b) : [...draft.binds, b] });
  const kind = KINDS.find((k) => k.kind === draft?.kind);

  const g = data ? groups(data.rules) : [];
  return (
    <Frame title="Rules" sub="What assistants and members may never do, only draft, or always ask about." top>
      <Footnote icon="shield">A rule only tightens. No rule grants anything, and a grant never waives a rule.</Footnote>
      {err ? <Card flush><EmptyState title="Rules did not answer" body={err} action={{ label: "Try again", onPress: load }} /></Card> : null}
      {!err && data === null ? <Card flush><EmptyState title="Loading" body="Asking your Vyre." /></Card> : null}

      {data?.proposals.length ? (
        <Sec title="Waiting for an owner">
          <Card flush>
            {data.proposals.map((p, i) => (
              <View key={p.id}>{i ? <Divider /> : null}
                <Row title={p.view} sub={`${proposer(p)} proposed this. It does nothing until an owner accepts it.`}
                  end={owner ? <View className="flex-row gap-s2"><Button size="sm" kind="primary" label="Accept" disabled={busy} onPress={() => act(() => acceptReal(p.id), "Accepted. The rule is in force.")} /><Button size="sm" kind="ghost" label="Turn down" disabled={busy} onPress={() => act(() => dismissReal(p.id), "Turned down.")} /></View> : <Chip>Needs an owner</Chip>} />
              </View>
            ))}
          </Card>
        </Sec>
      ) : null}

      {data && !g.length && !err ? <Card><EmptyState title="No rules yet" body="Nothing is held back by a standing rule. Add one when something must never go out, only be drafted, or always be asked about." /></Card> : null}
      {g.map((k) => (
        <Sec key={k.kind} title={k.title}>
          <Text size="caption" tone="label">{k.help}</Text>
          <Card flush>
            {k.rules.map((r, i) => (
              <View key={r.id}>{i ? <Divider /> : null}
                <Row title={r.view} sub={r.label} end={owner ? <Button kind="holdText" size="sm" label="Remove" disabled={busy} onPress={() => act(() => removeReal(r.id), "The rule is gone.")} /> : undefined} />
              </View>
            ))}
          </Card>
        </Sec>
      ))}

      <View className="self-start pt-s4"><Button kind="primary" icon="plus" label={owner ? "Add a rule" : "Propose a rule"} onPress={() => { setProblem(""); setDraft({ ...BLANK }); }} /></View>
      {!owner && data ? <Text size="caption" tone="label">Only an owner makes a rule. You can propose one.</Text> : null}

      <Sheet open={!!draft} onClose={() => setDraft(null)} title={owner ? "Add a rule" : "Propose a rule"}>
        {draft ? (
          <View className="gap-s3">
            <Segmented label="Kind" value={draft.kind} onChange={(k) => set({ kind: k })} options={KINDS.map((k) => [k.kind, k.title] as [Draft["kind"], string])} />
            <Text size="caption" tone="label">{kind?.help}</Text>
            <View className="flex-row flex-wrap gap-s2">
              <Chip selected={draft.binds.includes("assistants")} onPress={() => toggle("assistants")}>Assistants</Chip>
              <Chip selected={draft.binds.includes("members")} onPress={() => toggle("members")}>Members</Chip>
            </View>
            <Field label="Actions" placeholder="mail.send, calendar.write" value={draft.actions} onChangeText={(actions) => set({ actions })} />
            <Field label="Only on (optional)" placeholder="vyre://space/mailbox/*" value={draft.resource} onChangeText={(resource) => set({ resource })} />
            {draft.kind === "always_ask" ? (
              <View className="gap-s2">
                <Segmented label="Who approves" value={draft.approverKind} onChange={(approverKind) => set({ approverKind, approver: approverKind === "role" ? "owner" : "" })} options={[["role", "A role"], ["person", "A person"]]} />
                {draft.approverKind === "role"
                  ? <View className="flex-row flex-wrap gap-s2">{ROLES.map((r) => <Chip key={r} selected={draft.approver === r} onPress={() => set({ approver: r })}>{r}</Chip>)}</View>
                  : <Field label="Person" placeholder="their id" value={draft.approver} onChangeText={(approver) => set({ approver })} />}
              </View>
            ) : null}
            <Field label="Name" placeholder="Josh approves every calendar date" value={draft.label} onChangeText={(label) => set({ label })} />
            {problem ? <Banner tone="warn"><Text>{problem}</Text></Banner> : null}
            <Button kind="primary" label={busy ? "Saving" : owner ? "Add the rule" : "Propose it"} disabled={busy} onPress={save} />
          </View>
        ) : null}
      </Sheet>
    </Frame>
  );
}
