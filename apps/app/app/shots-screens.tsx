// Sample world only: the operator card and the sign-in card, for the screenshot pass. The live screen is Glass's and needs a box, so it is not opened here; the card's own still shows a stand-in picture.
import { View } from "react-native";
import { ThemeProvider, Text } from "@vyre/ui";
import { OperatorCard } from "../src/chat/OperatorCard";
import { SigninCard } from "../src/chat/SigninCard";

const PIC = "data:image/svg+xml;base64," + btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400"><rect width="640" height="400" fill="#f3f4f6"/><rect width="640" height="34" fill="#e5e7eb"/><circle cx="18" cy="17" r="5" fill="#f87171"/><circle cx="36" cy="17" r="5" fill="#fbbf24"/><circle cx="54" cy="17" r="5" fill="#34d399"/><rect x="90" y="8" width="300" height="18" rx="9" fill="#fff"/><rect x="0" y="34" width="150" height="366" fill="#1f2937"/><g fill="#9ca3af"><rect x="18" y="58" width="100" height="10" rx="5"/><rect x="18" y="88" width="80" height="10" rx="5"/><rect x="18" y="118" width="90" height="10" rx="5"/></g><text x="176" y="76" font-family="sans-serif" font-size="18" font-weight="600" fill="#111827">No-show workflow</text><rect x="176" y="96" width="430" height="64" rx="10" fill="#fff"/><rect x="176" y="172" width="430" height="64" rx="10" fill="#fff"/><rect x="176" y="248" width="430" height="64" rx="10" fill="#fff"/><rect x="192" y="116" width="140" height="10" rx="5" fill="#d1d5db"/><rect x="192" y="192" width="180" height="10" rx="5" fill="#d1d5db"/><rect x="192" y="268" width="120" height="10" rx="5" fill="#d1d5db"/></svg>`);
const steps = [{ line: "Opened app.example.test", state: "done" }, { line: "Typed the password from your Vault", state: "done" }, { line: "Opened the Test sub-account", state: "done" }, { line: "Reading the no-show workflow", state: "working" }];
export default function ShotsScreens() {
  return (
    <ThemeProvider>
      <View style={{ padding: 20, gap: 14, maxWidth: 620 }}>
        <OperatorCard block={{ block: "operator", run: "0a1b2c3d4e5f", computer: "kit", title: "Kit's computer", state: "working", line: "Reading the no-show workflow", ask: "", steps }} sample={PIC} />
        <OperatorCard block={{ block: "operator", run: "1b2c3d4e5f60", computer: "kit", title: "Kit's computer", state: "stuck", line: "The site asked for a code I do not have", ask: "The 6-digit code from your phone", steps: steps.slice(0, 2).concat([{ line: "The site asked for a code I do not have", state: "stuck" }]) }} sample={PIC} />
        <SigninCard block={{ block: "signin", id: "2c3d4e5f6071", computer: "kit", site: "GoHighLevel", why: "I need to read the no-show workflow's history.", state: "waiting" }} sample={[{ name: "GoHighLevel agency login", origin: "https://app.gohighlevel.test", exact: true }]} />
        <SigninCard block={{ block: "signin", id: "3d4e5f607182", computer: "kit", site: "GoHighLevel", why: "", state: "done" }} />
        <Text tone="label" size="caption">Sample world</Text>
      </View>
    </ThemeProvider>
  );
}
