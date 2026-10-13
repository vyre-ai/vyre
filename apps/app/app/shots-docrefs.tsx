// Sample world only: the instructions overlay with an @ and a # reference in the words, for the screenshot pass. The editor shows only the names; the row under the toolbar and the preview show the chips.
import { useState } from "react";
import { View } from "react-native";
import { DocOverlay, ThemeProvider } from "@vyre/ui";
import { DocMentionPanel } from "../src/chat/DocMentionPanel";
import { useAppearance } from "../ui/theme";

const DOC = `# Intake agent

You open every new matter. Ask [@Dana Okafor](vyre://acme/person/p_1) for the engagement letter and file it under [#Okafor estate](vyre://acme/matter/m_9).

- Tag anything about fees with [#billing](vyre://acme/tag/billing)
- Hand questions you cannot answer to [@juno](vyre://acme/agent/juno)
`;

// ?scheme=dark | paper picks the theme for the shot (the headless browser reports a light system).
if (typeof window !== "undefined") { const t = new URLSearchParams(window.location.search).get("scheme"); if (t === "dark" || t === "paper") useAppearance.getState().setPerson({ theme: t }); }

export default function ShotsDocRefs() {
  const [text] = useState(DOC);
  return (
    <ThemeProvider>
      <View style={{ flex: 1 }}>
        <DocOverlay open onClose={() => {}} title="Instructions" name="AGENTS.md" kind="markdown" assist={DocMentionPanel} onOpenRef={() => {}} source={{ load: async () => ({ text }), save: async () => ({}) }} />
      </View>
    </ThemeProvider>
  );
}
