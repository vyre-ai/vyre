import { View } from "react-native";
import { useRouter } from "expo-router";
import { Button, Card, Divider, EmptyState, IconTile, Row, Switch, Text, allowsMock } from "@vyre/ui";
import { RealFlows } from "./RealFlows";
import { Frame } from "../places/Frame";
import { usePhone } from "../places/Page";
import { inScope, useScope } from "../places/scope";
import { flowsRepo } from "./data";
import { useFlowsState } from "./store";
import { triggerIcon, triggerLine } from "./logic.js";

function SampleFlowsScreen() {
  const router = useRouter();
  const phone = usePhone();
  const { applied, off, setOn, installed } = useFlowsState();
  const scope = useScope((s) => s.scope);
  // Every sample Flow belongs to Harlow Legal. A real source says which space each one is in.
  const list = inScope(scope, "harlow") ? [...(applied ? [flowsRepo.engineerFlow()] : []), ...flowsRepo.flows()] : [];
  return (
    <Frame title="Flows" sub="What happens on its own when something changes, and who is asked." scope>
      <Card flush>
        {!list.length ? <EmptyState title="No Flows in Mine" body="Flows live in a space. Ask @Engineer to write one, or install a Kit." /> : null}
        {list.map((f, i) => {
          const waiting = f.id === "engagement";
          return (
            <View key={f.id}>{i ? <Divider inset={68} /> : null}
              <Row dense onPress={() => router.push(`/u/flows/${f.id}` as never)} lead={<IconTile size={40} name={triggerIcon(f)} />} title={f.name}
                sub={waiting
                  ? <View className="flex-row items-center gap-s2"><View className="rounded-full bg-accent" style={{ height: 6, width: 6 }} /><Text size="secondary" tone="accent" numberOfLines={1}>Waiting on you</Text></View>
                  : triggerLine(f)}
                chevron={waiting}
                end={waiting ? undefined : <Switch label={`${f.name} is ${off[f.id] ? "off" : "on"}`} on={!off[f.id]} onChange={(on) => setOn(f.id, on)} />} />
            </View>
          );
        })}
      </Card>
      <Card flush>
        <Row dense onPress={() => router.push("/u/kits" as never)} lead={<IconTile name="kits" />} title="Kits" state={`${installed.length} installed`} chevron />
      </Card>
      <View className="pt-s4"><Button kind="primary" size="lg" className={phone ? undefined : "self-start"} icon="spark" label="Ask @Engineer to write one" onPress={() => router.push("/u/engineer" as never)} /></View>
    </Frame>
  );
}

/** The sample list in a mock build; the vyred's own Flows everywhere else. */
export default function FlowsScreen() {
  return allowsMock() ? <SampleFlowsScreen /> : <RealFlows />;
}
