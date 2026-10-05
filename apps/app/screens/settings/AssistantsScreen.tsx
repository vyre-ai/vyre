import { View } from "react-native";
import { useRouter } from "expo-router";
import { Avatar, Button, Card, Chip, Divider, Segmented, Text, showToast, markRef , allowsMock} from "@vyre/ui";
import { Page } from "../places/Frame";
import { RealAssistants } from "./RealAgents";
import { useSettings } from "./state";
import { AUTONOMY } from "./logic.js";

/** Assistants: how much each does alone. Pausing keeps its notes. */
export function SampleAssistantsScreen() {
  const router = useRouter();
  const { assistants, setAutonomy, setPaused } = useSettings();
  return (
    <Page title="Assistants" back="/u/settings">
      <Card flush>
        {assistants.map((a, i) => (
          <View key={a.id}>
            {i ? <Divider /> : null}
            <View className="gap-s2 p-s3">
              <View className="flex-row items-center gap-s3">
                <Avatar of={markRef(a.family, a.name, a.id)} size={40} />
                <View className="min-w-0 flex-1"><View className="flex-row flex-wrap items-center gap-s2"><Text strong>{a.name}</Text>{a.paused ? <Chip tone="warn">Paused</Chip> : null}</View><Text size="caption" tone="label">{`${a.role} · ${a.model}`}</Text></View>
                <Button kind="ghost" size="sm" label={a.paused ? "Resume" : "Pause"} onPress={() => { setPaused(a.id, !a.paused); showToast(a.paused ? `${a.name} is working again.` : `Paused ${a.name}. It keeps its notes.`); }} />
              </View>
              <Segmented label={`${a.name} works`} value={a.autonomy} onChange={(v) => setAutonomy(a.id, v)} options={AUTONOMY as [string, string][]} />
            </View>
          </View>
        ))}
        <Divider />
        <View className="flex-row items-center gap-s3 p-s3">
          <Avatar of={markRef("agent", "@Engineer")} size={40} />
          <View className="min-w-0 flex-1"><View className="flex-row flex-wrap items-center gap-s2"><Text strong>@Engineer</Text><Chip>Admins only</Chip></View><Text size="caption" tone="label">Changes definitions in Harlow Legal. Cannot send, pay or read the Vault.</Text></View>
          <Button size="sm" label="Open" onPress={() => router.push("/u/engineer" as never)} />
        </View>
      </Card>
    </Page>
  );
}

/** The sample page in a mock build; the box's own agents and accounts everywhere else. */
export function AssistantsScreen() {
  return allowsMock() ? <SampleAssistantsScreen /> : <RealAssistants />;
}
