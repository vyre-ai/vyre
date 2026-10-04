import { useTabDrawn } from "../../src/perf/tabs";
import { EmptyHere } from "../../src/ui/EmptyHere";
import { Screen } from "../../src/ui/Screen";

export default function Agents() {
  useTabDrawn();
  return (
    <Screen title="Agents">
      <EmptyHere kind="agents" />
    </Screen>
  );
}
