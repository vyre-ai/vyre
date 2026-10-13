import { useLocalSearchParams } from "expo-router";
import { RunPage } from "../../../../../screens/flows/RunPage";

export default function Page() {
  const { id, run } = useLocalSearchParams<{ id: string; run: string }>();
  return <RunPage flow={String(id)} run={String(run)} />;
}
