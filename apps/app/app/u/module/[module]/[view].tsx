import { useLocalSearchParams } from "expo-router";
import { ModuleScreenHost } from "../../../../screens/shell/ModuleScreenHost";

// The route's second segment is named `view`, not `screen`: `screen` is a name React Navigation reserves for a nested navigator's screen, and a link to /u/module/<module>/<screen> lost it
// (the address became /u/module/<module>/undefined). `q` is an optional value the view starts with (a Contact's e-mail for "Send for signature").
export default function ModuleScreenRoute() {
  const { module, view, q } = useLocalSearchParams<{ module: string; view: string; q?: string }>();
  return <ModuleScreenHost module={String(module)} screen={String(view)} {...(q ? { q: String(q) } : {})} />;
}
