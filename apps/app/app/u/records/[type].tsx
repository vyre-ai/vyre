import { useLocalSearchParams } from "expo-router";
import { RecordsScreen } from "../../../screens/records/RecordsScreen";

export default function RecordsRoute() {
  const { type, view } = useLocalSearchParams<{ type: string; view?: string }>();
  return <RecordsScreen type={String(type)} {...(view ? { view: String(view) } : {})} />;
}
