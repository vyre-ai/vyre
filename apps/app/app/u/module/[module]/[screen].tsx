import { useLocalSearchParams } from "expo-router";
import { ModuleScreenHost } from "../../../../screens/shell/ModuleScreenHost";

export default function ModuleScreenRoute() {
  const { module, screen, q } = useLocalSearchParams<{ module: string; screen: string; q?: string }>();
  return <ModuleScreenHost module={String(module)} screen={String(screen)} {...(q ? { q: String(q) } : {})} />;
}
