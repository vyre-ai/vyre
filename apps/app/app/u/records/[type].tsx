import { useLocalSearchParams } from "expo-router";
import { RecordsScreen } from "../../../screens/records/RecordsScreen";

export default function RecordsRoute() {
  const { type } = useLocalSearchParams<{ type: string }>();
  return <RecordsScreen type={String(type)} />;
}
