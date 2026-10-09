import { useLocalSearchParams } from "expo-router";
import { TagScreen } from "../../../screens/tags/TagScreen";

export default function TagRoute() {
  const { tag } = useLocalSearchParams<{ tag: string }>();
  return <TagScreen tag={String(tag)} />;
}
