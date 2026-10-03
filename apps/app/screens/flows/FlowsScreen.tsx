import { View } from "react-native";
import { useRouter } from "expo-router";
import { Button, Card, Chip, Divider, EmptyState, Row } from "@vyre/ui";
import { IconTile, Page } from "../places/Page";
import { inScope, useScope } from "../places/scope";
import { flowsRepo } from "./data";
import { useFlowsState } from "./store";

export default function FlowsScreen() {
  const router = useRouter();
  const applied = useFlowsState((s) => s.applied);
  const scope = useScope((s) => s.scope);
  // Every sample Flow belongs to Harlow Legal. A real source says which space each one is in.
  const list = inScope(scope, "harlow") ? [...(applied ? [flowsRepo.engineerFlow()] : []), ...flowsRepo.flows()] : [];
  return (
    <Page title="Flows" sub="What happens on its own when something changes, and who is asked." actions={<Button kind="primary" icon="plus" label="Ask @Engineer to write one" onPress={() => router.push("/u/engineer" as never)} />}>
      <Card flush>
        {!list.length ? <EmptyState title="No Flows in Mine" body="Flows live in a space. Ask @Engineer to write one, or install a Kit." /> : null}
        {list.map((f, i) => {
          const waiting = f.id === "engagement";
          return (
            <View key={f.id}>{i ? <Divider /> : null}
              <Row onPress={() => router.push(`/u/flows/${f.id}` as never)} lead={<IconTile icon="refresh" />} title={f.name}
                sub={`When ${f.trigger.charAt(0).toLowerCase()}${f.trigger.slice(1)} · v${f.v} · last run ${f.last}`}
                end={<>{waiting ? <Chip tone="accent">Waiting on you</Chip> : null}<Chip tone="ok">{f.state}</Chip></>} />
            </View>
          );
        })}
      </Card>
      <View className="flex-row flex-wrap gap-s2">
        <Button icon="download" label="Kits" onPress={() => router.push("/u/kits" as never)} />
      </View>
    </Page>
  );
}
