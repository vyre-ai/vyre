// Vault's own list as the sidebar's panel (the same drill-in as Files, Chat and Build): Mine and Space, then the groups the page lists with how many each holds, then Expiring and Shared with me.
// Picking one narrows the page (vault-nav.ts). The counts are the page's own, so the two cannot disagree.
import { View } from "react-native";
import { SidebarRow, Text } from "@vyre/ui";
import type { IconName } from "@vyre/ui";
import { GROUPS, type Nav } from "./redesign.js";
import { useVaultNav } from "./vault-nav";

const ICON: Record<string, IconName> = { "AI models": "spark", "Email and sending": "mail", "Phone and texts": "phone", "Google and Microsoft": "globe", "Code and hosting": "term", Messaging: "chat", Logins: "key", "SSH keys": "term", "Secure notes": "file", "Any API key": "key" };

const count = (n: number) => <Text size="caption" tone="label">{String(n)}</Text>;
const same = (a: Nav, b: Nav) => a.kind === b.kind && (a.kind !== "group" || (b.kind === "group" && a.group === b.group));

export function VaultPanel() {
  const { scope, nav, counts, setScope, setNav } = useVaultNav();
  const pick = (n: Nav) => <SidebarRow key={n.kind === "group" ? n.group : n.kind} label={n.kind === "group" ? n.group : n.kind === "all" ? "Everything" : n.kind === "expiring" ? "Expiring" : "Shared with me"}
    icon={n.kind === "group" ? ICON[n.group] : n.kind === "all" ? "vault" : n.kind === "expiring" ? "clock" : "share"} on={same(nav, n)} onPress={() => setNav(n)}
    trailing={count(n.kind === "group" ? counts.groups[n.group] ?? 0 : n.kind === "all" ? counts.all : n.kind === "expiring" ? counts.expiring : counts.shared)} />;
  return (
    <View style={{ gap: 4 }}>
      <SidebarRow label="Mine" icon="person" on={scope === "mine"} onPress={() => setScope("mine")} />
      <SidebarRow label="Space" icon="space" on={scope === "space"} onPress={() => setScope("space")} />
      <View style={{ height: 8 }} />
      {pick({ kind: "all" })}
      {GROUPS.map((g) => pick({ kind: "group", group: g }))}
      <View style={{ height: 8 }} />
      {pick({ kind: "expiring" })}
      {scope === "space" ? pick({ kind: "shared" }) : null}
    </View>
  );
}
