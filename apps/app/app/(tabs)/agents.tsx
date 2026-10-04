import { useRouter } from "expo-router";
import { useTabDrawn } from "../../src/perf/tabs";
import { Empty, Screen } from "../../src/ui/Screen";

export default function Agents() {
  const router = useRouter();
  useTabDrawn();
  return (
    <Screen title="Agents">
      <Empty text="No agents yet" action={{ label: "Open Chats", onPress: () => router.push("/chats") }} />
    </Screen>
  );
}
