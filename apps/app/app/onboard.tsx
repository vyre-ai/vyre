// First run at /onboard: Identity, optional AI sign-in, a space, then Ready. Every step calls a registry tool.
import { ThemeProvider } from "@vyre/ui";
import { FirstRun } from "../screens/first-run/FirstRun";

export default function Onboard() {
  return (
    <ThemeProvider>
      <FirstRun />
    </ThemeProvider>
  );
}
