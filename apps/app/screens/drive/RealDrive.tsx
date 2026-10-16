// The Files screen on a phone and in a narrow window: three places (the Space's own Drive, what the person has shared, and folders linked from another service), each opened from one list.
import { useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Button, Card, Divider, IconTile, Row, SectionLabel } from "@vyre/ui";
import { Frame } from "../places/Frame";
import { SpaceDrive } from "./SpaceDrive";
import { Breadcrumb } from "./Breadcrumb";
import { SharedLinks } from "./SharedLinks";
import { LinkedFiles } from "./LinkedFiles";
import { SharedArtifacts } from "../chat-tools";
import { REAL_TABS } from "./tabs.js";
import { PlaceTag } from "../../src/real/PlaceTag";

type Tab = "space" | "shared" | "linked";
const ROOT_ICON: Record<string, string> = { space: "drive", shared: "share", linked: "link" };
const ROOT_SUB: Record<string, string> = { space: "The space's files, with their versions", shared: "Links you made, and what agents made for you", linked: "Live folders from Google Drive" };

export default function RealDrive() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab | null>(null);
  const [made, setMade] = useState(0);

  return (
    <Frame title="Files" sub="The space's files with their versions, what you have shared, and folders linked from other services." actions={<Button kind="secondary" size="sm" icon="file" label="Documents" onPress={() => router.push("/u/documents" as never)} />}>
      <PlaceTag of="home" />
      {tab === null ? (
        <Card flush>
          {(REAL_TABS as unknown as [Tab, string][]).map(([id, label], i) => (
            <View key={id}>{i ? <Divider inset={60} /> : null}<Row chevron lead={<IconTile name={ROOT_ICON[id] as never} />} title={label} sub={ROOT_SUB[id]} onPress={() => setTab(id)} /></View>
          ))}
        </Card>
      ) : <Breadcrumb crumbs={[{ name: "Files", key: "" }, { name: (REAL_TABS as unknown as [Tab, string][]).find((t) => t[0] === tab)?.[1] ?? "", key: tab }]} onPress={() => setTab(null)} />}
      {tab === null ? null : tab === "space" ? <SpaceDrive onLink={() => { setMade((n) => n + 1); setTab("shared"); }} /> : tab === "shared" ? <View className="gap-s3"><SectionLabel first>Links to files</SectionLabel><SharedLinks refresh={made} /><SectionLabel>Made for you</SectionLabel><SharedArtifacts /></View> : <LinkedFiles />}
    </Frame>
  );
}
