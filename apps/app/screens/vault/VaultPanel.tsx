// Vault's own list as the sidebar's panel (the same drill-in as Files, Chat and Build): Mine and Shared, then Everything and Expiring, then Shared's folders with how many each
// holds. Picking one narrows the page (vault-nav.ts). The counts are the page's own, so the two cannot disagree.
import { View } from "react-native";
import { SidebarRow, Text } from "@vyre/ui";
import type { Nav } from "./redesign.js";
import { useVaultNav } from "./vault-nav";

const count = (n: number) => <Text size="caption" tone="label">{String(n)}</Text>;
const same = (a: Nav, b: Nav) => a.kind === b.kind && (a.kind !== "folder" || (b.kind === "folder" && a.folder === b.folder));

export function VaultPanel() {
  const { scope, nav, counts, setScope, setNav } = useVaultNav();
  return (
    <View style={{ gap: 4 }}>
      <SidebarRow label="Mine" icon="person" on={scope === "mine"} onPress={() => setScope("mine")} />
      <SidebarRow label="Shared" icon="space" on={scope === "shared"} onPress={() => setScope("shared")} />
      <View style={{ height: 8 }} />
      <SidebarRow label="Everything" icon="vault" on={nav.kind === "all"} onPress={() => setNav({ kind: "all" })} trailing={count(counts.all)} />
      <SidebarRow label="Expiring" icon="clock" on={nav.kind === "expiring"} onPress={() => setNav({ kind: "expiring" })} trailing={count(counts.expiring)} />
      {scope === "shared" ? Object.entries(counts.folders ?? {}).map(([folder, n]) => {
        const pick: Nav = { kind: "folder", folder };
        return <SidebarRow key={folder} label={folder} icon="folder" on={same(nav, pick)} onPress={() => setNav(pick)} trailing={count(n)} />;
      }) : null}
    </View>
  );
}
