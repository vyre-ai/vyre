// The Connect apps screen on sample data: /connect-demo. No server behind it; see screens/connections/ConnectAppsPreview.tsx.
import { ThemeProvider } from "@vyre/ui";
import ConnectAppsPreview from "../screens/connections/ConnectAppsPreview";

export default function ConnectDemo() {
  return <ThemeProvider><ConnectAppsPreview /></ThemeProvider>;
}
