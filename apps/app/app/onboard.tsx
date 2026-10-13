// The onboarding prototype (mock build only): /onboard. The real first run (InstallScreen) is untouched.
import { ThemeProvider } from "@vyre/ui";
import { OnboardFlow } from "../screens/onboard/OnboardFlow";

export default function Onboard() {
  return (
    <ThemeProvider>
      <OnboardFlow />
    </ThemeProvider>
  );
}
