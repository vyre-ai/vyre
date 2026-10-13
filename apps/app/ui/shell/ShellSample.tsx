import { View } from "react-native";
import { Text } from "../components/Text";
import { Card } from "../components/Card";
import { SpaceTile } from "../components/SpaceTile";
import { SidebarRow } from "./SidebarRow";
import { TILE_PALETTE } from "../marks/space-tile.js";
import { Shell, type NavDef, type ShellSpace } from "./Shell";
import { RAIL } from "./rail-tokens.js";
import type { PanelDef } from "./SidebarPanel";

/** A small logo a person might upload, as a PNG data image (a navy square). */
const SAMPLE_LOGO = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGOQ13IhCTGMahjVMHw1AADSqY0BZKST9AAAAABJRU5ErkJggg==";

const SPACES: ShellSpace[] = [
  { id: "spc_juniperstudi", name: "Juniper Studio", sub: "6 people", logo: SAMPLE_LOGO },
  { id: "spc_northwindst", name: "Northwind Studio", sub: "3 people" },
  { id: "all", name: "All spaces", sub: "" },
];

const NAV: NavDef = {
  items: [
    { id: "now", label: "Now", icon: "now", href: "/u/now", badge: 3 },
    { id: "chat", label: "Chat", icon: "chat", href: "/u/chats" },
    { id: "projects", label: "Projects", icon: "projects", href: "/u/projects" },
    { id: "records", label: "Records", icon: "records", href: "/u/records/contact" },
    { id: "drive", label: "Files", icon: "drive", href: "/u/files" },
  ],
  groups: [
    { name: "AI", items: [{ id: "assistants", label: "Agents", icon: "assistants", href: "/u/assistants" }, { id: "flows", label: "Flows", icon: "flows", href: "/u/flows" }] },
  ],
  more: [],
  bottom: [{ id: "settings", label: "Settings", icon: "settings", href: "/u/settings" }],
};

const PROJECTS: PanelDef = {
  id: "projects", title: "Projects", icon: "projects", onBack: () => {}, search: "Search projects", currentHref: "/u/project/p2",
  items: [
    { id: "p1", label: "Smith probate", href: "/u/project/p1", group: "Matter" }, { id: "p2", label: "Jones estate plan", href: "/u/project/p2", group: "Matter" },
    { id: "p3", label: "Spring ads", href: "/u/project/p3", group: "Campaign" },
  ],
};
const RECORDS: PanelDef = {
  id: "records", title: "Records", icon: "records", onBack: () => {}, currentHref: "/u/records/contact", items: [],
  before: <>
    <SidebarRow label="Contacts" icon="contacts" on /><SidebarRow label="Leads" icon="list" /><SidebarRow label="Sales pipeline" icon="board" /><SidebarRow label="Appointments" icon="cal" />
  </>,
  after: <><SidebarRow label="All record types" icon="records" tone="label" /><SidebarRow label="New view" icon="plus" tone="label" /></>,
};

/** The real Shell around a sample page, in the state asked for: main, folded, or a place's panel. */
export function ShellSample({ state = "main", logo = true }: { state?: "main" | "folded" | "projects" | "records" | "projects-folded"; logo?: boolean }) {
  const spaces = logo ? SPACES : SPACES.map((s) => ({ ...s, logo: null }));
  const panel = state === "projects" || state === "projects-folded" ? PROJECTS : state === "records" ? RECORDS : null;
  const current = panel ? (panel.id === "projects" ? "/u/project/p2" : "/u/records/contact") : "/u/projects";
  return (
    <View style={{ width: 880, height: 700, overflow: "hidden", borderRadius: 16 }}>
      <Shell {...NAV} panel={panel} folded={state === "folded" || state === "projects-folded"} onSearch={() => {}} current={current} onNavigate={() => {}} spaces={spaces} space="spc_juniperstudi" onSpace={() => {}} user={{ name: "Alex Morgan", sub: "alex.vyre.run" }}>
        <View style={{ padding: RAIL.contentPad, gap: 20 }}>
          <Text size="page" strong>Projects</Text>
          <Text tone="muted">Matters your team and its assistants are working on.</Text>
          <Card><Text strong>Probate intake</Text><Text tone="muted" size="secondary">4 open, 1 waiting on you</Text></Card>
          <Card><Text strong>Estate plan refresh</Text><Text tone="muted" size="secondary">2 open</Text></Card>
        </View>
      </Shell>
    </View>
  );
}

/** A logo, a logo that failed, and every default tile of the curated palette. */
export function SpaceTileSheet() {
  const names = ["Juniper Studio", "Northwind Studio", "Mine", "Juniper", "Kestrel & Co", "Orchard Lane", "Pine Row", "Quill"];
  return (
    <View style={{ gap: 16 }}>
      <View style={{ flexDirection: "row", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <SpaceTile space={{ id: "x", name: "Juniper Studio", logo: SAMPLE_LOGO }} size={56} />
        <SpaceTile space={{ id: "x", name: "Juniper Studio", logo: SAMPLE_LOGO }} size={40} />
        <SpaceTile space={{ id: "x", name: "Broken logo", logo: "https://invalid.invalid/none.png" }} size={40} />
      </View>
      <View style={{ flexDirection: "row", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        {names.slice(0, TILE_PALETTE.length).map((n, i) => <SpaceTile key={n} space={{ id: `spc_p${i}`, name: n }} size={40} />)}
      </View>
    </View>
  );
}

/** Every state of the sidebar, for a person to read. */
export function ShellStates() {
  const states = ["main", "folded", "projects", "projects-folded", "records"] as const;
  return (
    <View style={{ gap: 32 }}>
      <SpaceTileSheet />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 32 }}>{states.map((s) => <View key={s} style={{ gap: 8 }}><Text strong>{s}</Text><ShellSample state={s} /></View>)}</View>
    </View>
  );
}
