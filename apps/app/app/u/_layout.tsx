// The new UI (@vyre/ui) mounts under /u until cutover: its own theme provider, the shell, its own stack.
// The install flow is a full screen of its own, so it skips the shell.
import { Stack, usePathname } from "expo-router";
import { ThemeProvider, useReducedMotion, useUiTheme } from "@vyre/ui";
import "../../src/api/store-link";
import { UiShell } from "../../screens/shell/UiShell";

function UiStack() {
  const { color } = useUiTheme();
  const path = usePathname();
  const reduced = useReducedMotion();
  // A record opens with the platform's own push (a spring on iOS, the system transition on Android) and the page's content then rises in with staggered
  // springs (Appear). Reduced motion: a plain fade. Shared-element transitions are not used; see the changelog.
  const stack = <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.bg }, animation: reduced ? "fade" : "default" }} />;
  return /^\/u\/install(\/|$)/.test(path) ? stack : <UiShell>{stack}</UiShell>;
}

export default function UiLayout() {
  return (
    <ThemeProvider>
      <UiStack />
    </ThemeProvider>
  );
}
