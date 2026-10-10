// Sample world only: Settings, Outside agents, in the states a person meets, for the screenshot pass: a freshly connected agent (its token shown once), the list with one agent holding records and a project's memory, and giving access.
import { View } from "react-native";
import { ThemeProvider } from "@vyre/ui";
import OutsideScreen, { type OutsideSample } from "../screens/settings/OutsideScreen";
import { useLocalSearchParams } from "expo-router";

const DAY = 86_400_000;
const now = Date.now();
const types = [{ name: "client", label: "Clients" }, { name: "matter", label: "Matters" }, { name: "contact", label: "Contacts" }];
const agents = [
  { id: "k3m9x2q7pw4t", name: "Muse", note: "Writes our newsletter", reach: "reads Clients and Matters; asks to add or change them", gives: [{ id: "rc_1", kind: "records", types: ["Clients", "Matters"], write: true }, { id: "rc_2", kind: "memory", projects: ["Harlow v. Harlow"] }], expires: now + 5 * DAY, lastUsed: now - 14 * 60_000, uses: 31, status: "active" as const },
  { id: "p8d2w5n1qz7c", name: "Hermes", note: "", reach: "", gives: [], expires: now + 7 * DAY, lastUsed: null, uses: 0, status: "active" as const },
  { id: "x1b6v3m9tk2r", name: "Dots", note: "Answers the intake line", reach: "reads Contacts", gives: [{ id: "rc_3", kind: "records", types: ["Contacts"] }], expires: now - DAY, lastUsed: now - 2 * DAY, uses: 120, status: "expired" as const },
];
const connected = { id: "p8d2w5n1qz7c", name: "Hermes", token: "vext_Zk3pQ9wL2mTxV8aBHq7nR4sD1yUeC6jMLw5vG0tF8oI", url: "https://harlow.vyre.run/agents-mcp", lines: { claude: 'claude mcp add --transport http vyre-hermes https://harlow.vyre.run/agents-mcp --header "Authorization: Bearer vext_Zk3pQ9wL2m..."', codex: "codex mcp add vyre-hermes --url https://harlow.vyre.run/agents-mcp --bearer-token-env-var VYRE_AGENT_TOKEN" } };
const STATES: Record<string, OutsideSample> = {
  list: { agents },
  connected: { agents, shown: connected },
  giving: { agents, giving: "p8d2w5n1qz7c", types, picked: ["client"], write: false },
  ending: { agents, ending: "k3m9x2q7pw4t" },
  empty: { agents: [] },
};

export default function ShotsOutside() {
  const q = useLocalSearchParams<{ state?: string }>();
  const sample = STATES[q.state ?? "list"] ?? STATES.list;
  return (
    <ThemeProvider>
      <View style={{ flex: 1, minHeight: 900 }}><OutsideScreen sample={sample} /></View>
    </ThemeProvider>
  );
}
