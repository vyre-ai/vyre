// Sample world only: the operator card and the sign-in card, for the screenshot pass. The live screen is Glass's and needs a box, so it is not opened here.
import { View } from "react-native";
import { ThemeProvider, Text } from "@vyre/ui";
import { OperatorCard } from "../src/chat/OperatorCard";
import { SigninCard } from "../src/chat/SigninCard";

const steps = [{ line: "Opened app.example.test", state: "done" }, { line: "Typed the password from your Vault", state: "done" }, { line: "Opened the Test sub-account", state: "done" }, { line: "Reading the no-show workflow", state: "working" }];
export default function ShotsScreens() {
  return (
    <ThemeProvider>
      <View style={{ padding: 20, gap: 14, maxWidth: 620 }}>
        <OperatorCard block={{ block: "operator", run: "0a1b2c3d4e5f", computer: "kit", title: "Kit's computer", state: "working", line: "Reading the no-show workflow", steps }} />
        <OperatorCard block={{ block: "operator", run: "1b2c3d4e5f60", computer: "kit", title: "Kit's computer", state: "stuck", line: "The site asked for a code I do not have", steps: steps.slice(0, 2).concat([{ line: "The site asked for a code I do not have", state: "stuck" }]) }} />
        <SigninCard block={{ block: "signin", id: "2c3d4e5f6071", computer: "kit", site: "GoHighLevel", why: "I need to read the no-show workflow's history.", state: "waiting" }} />
        <SigninCard block={{ block: "signin", id: "3d4e5f607182", computer: "kit", site: "GoHighLevel", why: "", state: "done" }} />
        <Text tone="label" size="caption">Sample world</Text>
      </View>
    </ThemeProvider>
  );
}
