// The new UI (@vyre/ui) mounts under /u until cutover: its own theme provider, the shell, its own stack.
// The install flow is a full screen of its own, so it skips the shell.
import { Stack, usePathname } from "expo-router";
import { ThemeProvider, useUiTheme } from "@vyre/ui";
import { UiShell } from "../../screens/shell/UiShell";

function UiStack() {
  const { color } = useUiTheme();
  const path = usePathname();
  const stack = <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.bg } }} />;
  return /^\/u\/install(\/|$)/.test(path) ? stack : <UiShell>{stack}</UiShell>;
}

export default function UiLayout() {
  return (
    <ThemeProvider>
      <UiStack />
    </ThemeProvider>
  );
}
