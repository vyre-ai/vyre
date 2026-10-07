import { useLocalSearchParams } from "expo-router";
import { RecordScreen } from "../../../screens/records/RecordScreen";

export default function RecordRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <RecordScreen id={String(id)} />;
}
