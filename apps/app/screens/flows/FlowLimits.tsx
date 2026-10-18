import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { Button, Card, Chip, Divider, Field, Row, Text, showToast } from "@vyre/ui";
import { Sec } from "../places/Frame";
import { callT } from "../../src/real/call-tool";
import { limitsSource, type Budget, type Control, type ConnectionUse } from "./limits-source";
import { budgetWords, controlWords, tokensFrom } from "./limits-model.js";

/** Settings of a Flow's page, Limits and Connections used: the Space's daily AI allowance (an owner or an admin sets it) and whether Flows are running, and the Connections this Flow uses. */
export function FlowLimits({ id }: { id: string }) {
  const src = useMemo(() => limitsSource(callT), []);
  const [budget, setBudget] = useState<Budget | null>(null);
  const [control, setControl] = useState<Control | null>(null);
  const [conns, setConns] = useState<ConnectionUse[]>([]);
  const [text, setText] = useState("");
  const [n, setN] = useState(0);
  useEffect(() => { void src.budget().then(setBudget); void src.control().then(setControl); void src.connectionsOf(id).then(setConns); }, [id, n, src]);
  const save = async () => {
    const t = tokensFrom(text);
    if (t === null) { showToast("Enter a whole number above zero."); return; }
    const r = await src.setBudget(t);
    if (r.message) showToast(r.message); else { setText(""); setN((x) => x + 1); }
  };
  return (
    <>
      <Sec title="Limits">
        <Card>
          <View className="gap-s2">
            {control ? <Text>{controlWords(control)}</Text> : null}
            {budget ? <View className="flex-row items-center gap-s2"><Text>{budgetWords(budget).line}</Text>{budgetWords(budget).low ? <Chip tone="warn">Nearly used up</Chip> : null}</View> : <Text tone="muted">The allowance could not be read.</Text>}
            <View className="flex-row items-end gap-s2">
              <View className="min-w-0 flex-1"><Field label="Daily AI allowance for Flows (tokens)" value={text} onChangeText={setText} placeholder={budget ? String(budget.tokens_per_day) : ""} help="For the whole Space. Only an owner or an admin can change it." /></View>
              <Button kind="secondary" size="sm" label="Save" disabled={!text.trim()} onPress={() => void save()} />
            </View>
          </View>
        </Card>
      </Sec>
      <Sec title="Connections used">
        {conns.length ? (
          <Card flush>{conns.map((c, i) => (
            <View key={c.connection}>{i ? <Divider /> : null}
              <Row dense title={c.connection} sub={c.flows.find((f) => f.id === id)?.line || undefined} end={c.flows.find((f) => f.id === id)?.level === "red" ? <Chip tone="err">Needs attention</Chip> : undefined} />
            </View>
          ))}</Card>
        ) : <Text tone="muted">This Flow uses no Connections.</Text>}
      </Sec>
    </>
  );
}
