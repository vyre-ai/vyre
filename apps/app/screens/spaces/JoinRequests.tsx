import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Banner, Button, Card, Row, Switch, Text } from "@vyre/ui";
import { MOCK, said, tool } from "../../src/real/box";
import { ASK_COPY, entryWords } from "./join-requests-model.js";

type Waiting = { id: string; identity: string; entry: string; name: string | null; note: string; created: number };
type State = { accepting: boolean; requests: Waiting[]; refused: number; open: number; cap: number };

/**
 * Settings, People: "Let people ask to join" (off by default; the owner's own presence turns it on) and the asks waiting. An ask opens to show who (the username the directory confirmed), the four words of their
 * device to check with them, and their note as plain text. Approving makes the invite for that person the ordinary way (their id, the member role, the owner's own presence) and links it to the ask; the asker's app
 * then joins with it. Declining says nothing more to them than "Not accepted."
 */
export function JoinRequests({ space, label }: { space: string; label: string }) {
  const [st, setSt] = useState<State | null>(null);
  const [problem, setProblem] = useState("");
  const [listed, setListed] = useState("");
  const [open, setOpen] = useState("");
  const [words, setWords] = useState<string[] | undefined>(undefined);
  const [busy, setBusy] = useState("");
  const [stage, setStage] = useState("");
  const load = useCallback(async () => {
    if (MOCK || !/^spc_[a-z2-7]{12,26}$/.test(space)) return;
    try { const { teamRequests } = await import("../../src/real/team-join"); setSt((await teamRequests(space)) as State); setListed(""); } catch (e) { setListed(said(e)); }
  }, [space]);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 15000); return () => clearInterval(t); }, [load]);
  useEffect(() => { void import("@vyre/relay-client/words.js").then((m) => setWords(m.WORDS as unknown as string[])).catch(() => {}); }, []);
  if (MOCK || !st) return listed ? <Banner icon="refresh"><Text tone="warn">{listed}</Text></Banner> : null;
  const act = async (key: string, fn: () => Promise<unknown>) => { setBusy(key); setProblem(""); try { await fn(); await load(); setOpen(""); } catch (e) { setProblem(said(e)); } setBusy(""); setStage(""); };
  const approve = (r: Waiting) => act(r.id, async () => {
    const { makeTeamInvite, teamDecide } = await import("../../src/real/team-join");
    // the invite is made through the ordinary path, for this person's id, with the owner's own presence; the ask is then linked to it
    setStage("Making their invite.");
    const made = await makeTeamInvite({ space, name: label, role: "member", to: r.identity, ttlDays: 7 });
    // the Space's door checks, under the approver's own chain, that this invite is theirs, unused, for this person and a role they may give, before it is linked
    setStage("Letting them in.");
    await teamDecide(space, { id: r.id, approve: true, invite: made.token });
  });
  return (
    <Card>
      <Row title={ASK_COPY.settingTitle} sub={ASK_COPY.settingHelp} end={<Switch label={ASK_COPY.settingTitle} on={st.accepting} onChange={(v) => void act("setting", async () => (await import("../../src/real/team-join")).teamSetting(space, v))} />} />
      {stage ? <Banner icon="refresh"><Text>{stage}</Text></Banner> : null}
      {problem ? <Banner icon="refresh"><Text tone="warn">{problem}</Text></Banner> : null}
      {st.refused > 0 ? <Banner icon="refresh"><View className="gap-s2"><Text>{`Requests are being refused: ${st.open} waiting.`}</Text><View className="self-start"><Button size="sm" label="Clear all" loading={busy === "clear"} onPress={() => void act("clear", async () => (await import("../../src/real/team-join")).teamClear(space))} /></View></View></Banner> : null}
      {st.requests.map((r) => (
        <View key={r.id} className="gap-s2 p-s3">
          <Row dense title={ASK_COPY.reviewTitle(r.name || "Someone")} sub="Check their four words with them before you approve." chevron onPress={() => setOpen(open === r.id ? "" : r.id)} />
          {open === r.id ? (
            <View className="gap-s2">
              <Text tone="muted">{ASK_COPY.reviewHelp}</Text>
              <Text strong accessibilityLabel="Their four words">{entryWords(words, r.entry) || "The words could not be worked out here."}</Text>
              {r.note ? <View className="gap-s1"><Text size="caption" tone="label">{ASK_COPY.noteLabel}</Text><Text>{r.note}</Text></View> : null}
              <View className="flex-row gap-s2">
                <Button kind="primary" size="sm" label={ASK_COPY.approve} loading={busy === r.id} onPress={() => void approve(r)} />
                <Button kind="ghost" size="sm" label={ASK_COPY.decline} onPress={() => void act(r.id, async () => (await import("../../src/real/team-join")).teamDecide(space, { id: r.id, approve: false }))} />
              </View>
            </View>
          ) : null}
        </View>
      ))}
    </Card>
  );
}
