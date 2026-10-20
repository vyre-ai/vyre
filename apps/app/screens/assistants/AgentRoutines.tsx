// "Routines and watchers": what an agent set up for itself when a person asked, and its duties, as one list. The agent's panel beside a chat shows it short; its page
// (Apps, Agents, the agent) shows it with next run, last run and its result, items found and failures. There is no form: the person asks the agent in chat, and this only
// pauses, resumes, runs now and deletes.
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Button, Card, Chip, Divider, IconTile, Row, Text, showToast } from "@vyre/ui";
import { callT } from "../../src/real/call-tool";
import { routinesSource } from "./routines-source";
import { ACT_LABEL, actDone, detailLines, emptyLine, rowLine, type Act, type Row as R } from "./routines-model.js";

const source = routinesSource(callT);
const say = (e: unknown) => (e instanceof Error && e.message ? e.message : "That did not go through.");

/** The list drawn from given rows: the panel's short form, or the page's with detail lines. No tool is called here. */
export function RoutinesView({ agent, rows, detail, busy, note, onAct }: { agent: string; rows: R[] | null; detail?: boolean; busy?: string; note?: string; onAct?: (r: R, a: Act) => void }) {
  return (
    <View className="gap-s2">
      <Text size="caption" strong tone="label">Routines and watchers</Text>
      {note ? <Text size="caption" tone="label">{note}</Text> : null}
      <Card flush>
        {rows && rows.length ? rows.map((r, i) => (
          <View key={r.key}>
            {i ? <Divider inset={detail ? 68 : 0} /> : null}
            <Row dense lead={detail ? <IconTile size={40} name={r.kind === "routine" ? "clock" : "eye"} /> : undefined}
              title={r.title}
              sub={
                <View className="gap-s1">
                  <Text size="secondary" tone="label" numberOfLines={2}>{`${r.kind === "routine" ? "Routine" : "Watcher"} · ${rowLine(r)}`}</Text>
                  {detail ? detailLines(r).map((l) => <Text key={l} size="caption" tone={/^Failed|failure/.test(l) ? "warn" : "label"} numberOfLines={2}>{l}</Text>) : null}
                </View>
              }
              end={<Chip tone={r.tone}>{r.word}</Chip>} />
            {onAct && r.actions.length ? (
              <View className="flex-row flex-wrap gap-s2 px-s3 pb-s3">
                {r.actions.map((a) => <Button key={a} size="sm" kind={a === "delete" ? "ghost" : "secondary"} label={ACT_LABEL[a]} disabled={!!busy} onPress={() => onAct(r, a)} />)}
              </View>
            ) : null}
          </View>
        )) : <View className="p-s3"><Text tone="muted">{rows ? emptyLine(agent) : "Reading the list."}</Text></View>}
      </Card>
    </View>
  );
}

/** The live list for one agent: drawn from the last copy at once, refreshed behind it; each act refreshes it. */
export function AgentRoutines({ agent, detail }: { agent: string; detail?: boolean }) {
  const [rows, setRows] = useState<R[] | null>(() => source.cached(agent));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState("");
  const load = useCallback(() => { source.list(agent).then((r) => { setRows(r); setNote(""); }).catch((e) => { setNote(`The list did not refresh. ${say(e)}`); setRows((x) => x ?? []); }); }, [agent]);
  useEffect(load, [load]);
  const act = (r: R, a: Act) => {
    setBusy(`${r.key}:${a}`);
    source.act(r, a).then(() => { showToast(actDone(r, a)); load(); }).catch((e) => showToast(say(e))).finally(() => setBusy(""));
  };
  return <RoutinesView agent={agent} rows={rows} detail={detail} busy={busy} note={note} onAct={act} />;
}
