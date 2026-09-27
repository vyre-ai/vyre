import { useTabDrawn } from "../../src/perf/tabs";
import { Empty, Screen } from "../../src/ui/Screen";

export default function Agents() {
  useTabDrawn();
  return (
    <Screen title="Agents">
      <Empty text="No agents yet" />
    </Screen>
  );
}
