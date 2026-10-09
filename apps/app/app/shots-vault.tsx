// Sample world only: the Vault's Import page against a fake box, and the chat's key tags, for the screenshot pass. Nothing is read or stored. ?part=chat shows the tags.
import { View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { Chip, ThemeProvider, Text } from "@vyre/ui";
import { Frame } from "../screens/places/Frame";
import ImportPage, { type Io } from "../screens/vault/ImportPage";
import { UserText } from "../src/chat/ChatRows";

const preview = {
  format: "bitwarden-json", token: "t", counts: { login: 96, note: 20, card: 3, "api-key": 2 }, add: ["Harlow Legal", "Northwind Bakery", "Oakline Dental", "Juniper Drive", "Brightwell Law", "Gmail intake", ...Array.from({ length: 100 }, (_, i) => `site-${i}`)],
  same: ["Stripe", "Gmail"], conflicts: [{ name: "Xero", existing: "Xero" }], renamed: [], skipped: ["row 14: no password"],
};
const scan = { scanned: 9, templates: 1, truncated: false, files: [
  { project: "Juniper intake", file: "/home/alex/code/juniper-intake/.env", secrets: 4, kinds: ["stripe", "openai", "supabase"], git: { tracked: false, ignored: true } },
  { project: "Juniper intake", file: "/home/alex/code/juniper-intake/apps/web/.env.local", secrets: 2, kinds: ["supabase"], git: { tracked: false, ignored: true } },
  { project: "Harlow site", file: "/home/alex/code/harlow-site/.env", secrets: 5, kinds: ["resend", "stripe"], git: { tracked: true, ignored: false } },
] };
const io: Io = {
  pick: async () => ({ name: "bitwarden_export.json", base64: "e30=" }),
  source: {
    preview: async () => preview,
    run: async () => ({ format: "bitwarden-json", added: preview.add, updated: [], same: preview.same, conflicts: ["Xero"], renamed: [], skipped: preview.skipped }),
    scan: async () => scan,
    moveEnv: async () => ({ format: "env", added: ["a", "b", "c"], updated: [], same: [], conflicts: [], renamed: [], skipped: [], rewritten: ["/x/.env", "/y/.env", "/z/.env"], unchanged: [], committed: ["/z/.env"] }),
  },
};

export default function ShotsVault() {
  const q = useLocalSearchParams<{ part?: string }>();
  return (
    <ThemeProvider>
      {q.part === "chat" ? (
        <View style={{ padding: 24, gap: 24, maxWidth: 640 }}>
          <UserText text="Deploy the intake site with vault://anthropic-key and tell me when it is live." pending={false} />
          <Chip tone="ok" icon="shield">Securing your Anthropic key in the Vault</Chip>
          <UserText text="Here is the Stripe key: vault://stripe-key. The webhook secret is vault://stripe-webhook-secret." pending={false} />
          <Text tone="label" size="caption">Sample world</Text>
        </View>
      ) : (
        <Frame title="Vault" sub="Logins, keys and cards."><ImportPage reload={() => {}} io={io} /></Frame>
      )}
    </ThemeProvider>
  );
}
