// The Vault's Advanced page: everything rare, in one place, off the main screen. Bringing items in from another password manager, health and breach checks, passes for outside
// agents, browsers, emergency access, SSH keys, devices, the recovery kit and backups, and every item with its history and the expert kinds (a service-account key file, an Apps
// Script web app, a bare MCP token). Each part is the one the Vault already had; only where it sits changed.
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "expo-router";
import { Card, IconTile, Row, Text, type IconName } from "@vyre/ui";
import { Frame } from "../places/Frame";
import { EmbedFrame } from "../settings/embed";
import { within } from "../../src/state/kept-model.js";
import { claimBlocked } from "../shell/rc";
import { ON_PHONE } from "../../src/real/on-phone.js";
import ImportPage from "./ImportPage";
import RealVault from "./RealVault";
import { DevicesPage, EmergencySection, PassesPage, SshSheet, WatchtowerPage } from "./RealVaultMore";
import { listReal } from "./real";
import type { ListRow } from "./real-model";

type Part = "import" | "health" | "passes" | "browsers" | "emergency" | "all";
const PARTS: { id: Part | "ssh" | "devices" | "backups"; icon: IconName; title: string; sub: string }[] = [
  { id: "import", icon: "download", title: "Import from another password manager", sub: "1Password, Bitwarden, Chrome, Dashlane, or your project's .env files" },
  { id: "health", icon: "shield", title: "Health and breach check", sub: "Weak, reused, old and leaked passwords and keys" },
  { id: "passes", icon: "share", title: "Passes for outside agents", sub: "Let an agent outside Vyre use an item, with an end date" },
  { id: "browsers", icon: "globe", title: "Browsers", sub: "Fill logins in your browsers" },
  { id: "emergency", icon: "hand", title: "Emergency access", sub: "Someone you trust can ask for your items, after a wait" },
  { id: "ssh", icon: "term", title: "SSH keys", sub: "Make a key on your computer, or add one you have" },
  { id: "devices", icon: "devices", title: "Devices", sub: "The devices that can open the Vault" },
  { id: "backups", icon: "recovery", title: "Recovery kit and backups", sub: "Get your items back if you lose a device" },
  { id: "all", icon: "list", title: "Every item, with its history", sub: "Earlier versions, and expert kinds: a service-account key file, an Apps Script web app, an MCP token" },
];

export default function VaultAdvanced({ embedded = false }: { embedded?: boolean } = {}) {
  const router = useRouter();
  const [part, setPart] = useState<Part | null>(null);
  const [ssh, setSsh] = useState(false);
  const [rows, setRows] = useState<ListRow[]>([]);
  const load = useCallback(() => { within(listReal()).then((r) => setRows(r.items)).catch(() => setRows([])); }, []);
  useEffect(load, [load]);
  const openItem = () => router.push("/u/vault" as never);
  const props = { rows, reload: load, openItem };

  if (part === "all") return <RealVault />;
  const title = PARTS.find((p) => p.id === part)?.title;
  if (part) {
    return (
      <Frame title={title ?? "Advanced"} onBack={() => setPart(null)}>
        {part === "import" ? (claimBlocked() ? <Text tone="muted">{ON_PHONE.replace("Do this", "Import")}</Text> : <ImportPage reload={load} />)
          : part === "health" ? <WatchtowerPage {...props} />
          : part === "passes" ? <PassesPage {...props} />
          : part === "browsers" ? <DevicesPage {...props} />
          : <EmergencySection reload={load} />}
      </Frame>
    );
  }
  const pick = (id: (typeof PARTS)[number]["id"]) => {
    if (id === "ssh") setSsh(true);
    else if (id === "devices") router.push("/u/settings/devices" as never);
    else if (id === "backups") router.push("/u/settings/backups" as never);
    else setPart(id);
  };
  return (
    <EmbedFrame embedded={embedded} title="Advanced" sub="The Vault's rarer tools." onBack={embedded ? undefined : () => router.push("/u/vault" as never)}>
      <Card flush>{PARTS.map((p) => <Row key={p.id} dense chevron lead={<IconTile name={p.icon} />} title={p.title} sub={p.sub} onPress={() => pick(p.id)} />)}</Card>
      <SshSheet open={ssh} onClose={() => setSsh(false)} onMade={() => { setSsh(false); load(); }} />
    </EmbedFrame>
  );
}
