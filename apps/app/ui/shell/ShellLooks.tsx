import { View } from "react-native";
import { Text } from "../components/Text";
import { Card } from "../components/Card";
import { SpaceTile } from "../components/SpaceTile";
import { TILE_PALETTE } from "../marks/space-tile.js";
import { Shell, type NavDef, type ShellSpace } from "./Shell";
import { LOOKS, LOOK_NAMES, lookOf, type ShellLookName } from "./looks-ts";

/** A small logo a person might upload, as a data image: a navy square with a cream arch. */
const SAMPLE_LOGO = "data:image/svg+xml;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#1F2A44"/><path d="M16 50V30a16 16 0 0 1 32 0v20" fill="none" stroke="#F1EEE6" stroke-width="6" stroke-linecap="round"/></svg>');

const SPACES: ShellSpace[] = [
  { id: "spc_juniperstudi", name: "Juniper Studio", sub: "6 people", logo: SAMPLE_LOGO },
  { id: "spc_northwindst", name: "Northwind Studio", sub: "3 people" },
  { id: "spc_mineonlyyyy", name: "Mine", sub: "Just you" },
  { id: "all", name: "All spaces", sub: "" },
];

const NAV: NavDef = {
  items: [
    { id: "now", label: "Now", icon: "now", href: "/u/now", badge: 3 },
    { id: "chat", label: "Chat", icon: "chat", href: "/u/chat" },
    { id: "projects", label: "Projects", icon: "projects", href: "/u/projects" },
    { id: "contacts", label: "Contacts", icon: "contacts", href: "/u/contacts" },
    { id: "drive", label: "Drive", icon: "drive", href: "/u/drive" },
  ],
  groups: [{ name: "Pinned", items: [{ id: "intake", label: "Intake desk", icon: "records", href: "/u/intake" }, { id: "billing", label: "Billing", icon: "card", href: "/u/billing" }] }],
  more: [{ id: "vault", label: "Vault", icon: "vault", href: "/u/vault" }],
  bottom: [{ id: "search", label: "Search", icon: "search", href: "/u/search" }, { id: "settings", label: "Settings", icon: "settings", href: "/u/settings" }],
};

/** One look, drawn as the real Shell around a sample page, so the rail, its marks and the content's breathing room are judged together. */
export function ShellSample({ look, current = "/u/projects", logo = true }: { look: ShellLookName; current?: string; logo?: boolean }) {
  const l = lookOf(look);
  const spaces = logo ? SPACES : SPACES.map((s) => ({ ...s, logo: null }));
  return (
    <View style={{ width: 880, height: 780, overflow: "hidden", borderRadius: 16, borderWidth: 1, borderColor: "transparent" }}>
      <Shell {...NAV} look={look} current={current} onNavigate={() => {}} spaces={spaces} space="spc_juniperstudi" onSpace={() => {}} user={{ name: "Alex Morgan", sub: "Owner" }}>
        <View style={{ padding: l.contentPad, gap: 20 }}>
          <Text size="page" strong>Projects</Text>
          <Text tone="muted">Matters your team and its assistants are working on.</Text>
          <Card><Text strong>Probate intake</Text><Text tone="muted" size="secondary">4 open, 1 waiting on you</Text></Card>
          <Card><Text strong>Estate plan refresh</Text><Text tone="muted" size="secondary">2 open</Text></Card>
        </View>
      </Shell>
    </View>
  );
}

/** Every default tile from the curated palette, plus a logo, at the sizes the rail and cards use. */
export function SpaceTileSheet() {
  const names = ["Juniper Studio", "Northwind Studio", "Mine", "Juniper", "Kestrel & Co", "Orchard Lane", "Pine Row", "Quill"];
  return (
    <View style={{ gap: 16 }}>
      <View style={{ flexDirection: "row", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <SpaceTile space={{ id: "x", name: "Juniper Studio", logo: SAMPLE_LOGO }} size={56} />
        <SpaceTile space={{ id: "x", name: "Juniper Studio", logo: SAMPLE_LOGO }} size={40} />
        <SpaceTile space={{ id: "x", name: "Juniper Studio", logo: SAMPLE_LOGO }} size={28} shape="round" />
        <SpaceTile space={{ id: "x", name: "Broken logo", logo: "https://invalid.invalid/none.png" }} size={40} />
        <Text tone="label" size="secondary">logo (squircle, round) and a logo that did not load</Text>
      </View>
      <View style={{ flexDirection: "row", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        {names.slice(0, TILE_PALETTE.length).map((n, i) => <SpaceTile key={n} space={{ id: `spc_p${i}`, name: n }} size={40} />)}
      </View>
    </View>
  );
}

/** The three looks side by side (they wrap on a narrow window), each named with its one line. */
export function ShellLooks() {
  return (
    <View style={{ gap: 32 }}>
      <SpaceTileSheet />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 32 }}>
        {LOOK_NAMES.map((k) => (
          <View key={k} style={{ gap: 8 }}>
            <Text strong>{LOOKS[k].name}</Text>
            <Text tone="muted" size="secondary">{LOOKS[k].line}</Text>
            <ShellSample look={k} />
          </View>
        ))}
      </View>
    </View>
  );
}
