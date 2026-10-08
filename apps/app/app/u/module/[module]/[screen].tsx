import { useLocalSearchParams } from "expo-router";
import { ModuleScreenHost } from "../../../../screens/shell/ModuleScreenHost";

export default function ModuleScreenRoute() {
  const { module, screen } = useLocalSearchParams<{ module: string; screen: string }>();
  return <ModuleScreenHost module={String(module)} screen={String(screen)} />;
}
