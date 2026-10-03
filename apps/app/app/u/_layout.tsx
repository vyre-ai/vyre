// The new UI (@vyre/ui) mounts under /u until cutover: its own theme provider, its own stack.
import { Stack } from "expo-router";
import { ThemeProvider, useUiTheme } from "@vyre/ui";

function UiStack() {
  const { color } = useUiTheme();
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.bg } }} />;
}

export default function UiLayout() {
  return (
    <ThemeProvider>
      <UiStack />
    </ThemeProvider>
  );
}
