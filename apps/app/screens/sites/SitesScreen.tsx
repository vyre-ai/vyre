import { useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Button, Card, Chip, Divider, EmptyState, IconTile, Row, Sheet, Text , allowsMock} from "@vyre/ui";
import { Frame } from "../places/Frame";
import { SpaceBadge } from "../places/badge";
import { inScope, useScope } from "../places/scope";
import { useSites } from "./store";
import type { Site } from "./data";
import { liveOf, previewOf, publishNew, SOURCES, statusOf } from "./logic.js";
import { RealSites } from "./RealSites";

const HOW: { kind: keyof typeof SOURCES; title: string; body: string; name: string }[] = [
  { kind: "github", title: "From a GitHub repo", body: "Builds on every push to the branch you pick.", name: "Referral form" },
  { kind: "drive", title: "From a Drive folder", body: "Publishes the pages in a folder and keeps in step with it.", name: "Northwind menu site" },
  { kind: "artifact", title: "From an assistant's artifact", body: "Packages what an assistant built in a chat.", name: "Fee calculator" },
];

function SampleSitesScreen() {
  const scope = useScope((s) => s.scope);
  const router = useRouter();
  const { sites, setSites } = useSites();
  const [pick, setPick] = useState(false);
  const rows = sites.filter((s) => inScope(scope, s.sp));
  return (
    <Frame title="Sites" sub="Sites and apps you publish, each one on its own." scope actions={<Button kind="primary" icon="plus" label="Publish" onPress={() => setPick(true)} />}>
      <Card flush>
        {rows.length ? rows.map((s, i) => {
          const live = liveOf(s), pre = previewOf(s), st = statusOf(s);
          return (
            <View key={s.id}>{i ? <Divider inset={60} /> : null}
              <Row dense chevron onPress={() => router.push(`/u/sites/${s.id}` as never)} lead={<IconTile name={s.type === "App" ? "term" : "sites"} badge={<SpaceBadge sp={s.sp} />} />} title={s.name}
                sub={`${s.type}, live ${live ? live.v : "none"} at ${s.dom.name}${pre ? `, ${pre.v} in preview` : ""}`}
                end={<Chip tone={st.tone}>{st.label}</Chip>} />
            </View>
          );
        }) : <EmptyState title="Nothing published in this space" body="Publish a site from a repo, a Drive folder or an assistant's artifact." action={{ label: "Publish", onPress: () => setPick(true) }} />}
      </Card>
      <Sheet open={pick} onClose={() => setPick(false)} title="Publish from">
        {HOW.map((h) => (
          <Row key={h.kind} title={h.title} sub={h.body} lead={<IconTile name={h.kind === "github" ? "link" : h.kind === "drive" ? "drive" : "chat"} />}
            onPress={() => { setSites((xs) => publishNew(xs, h.kind, h.name) as Site[]); setPick(false); router.push(`/u/sites/${h.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` as never); }} />
        ))}
        <Text size="caption" tone="label">Nothing goes live until you say so.</Text>
      </Sheet>
    </Frame>
  );
}

/** The sample site in a mock build; the box's own publishing everywhere else. */
export default function SitesScreen() {
  return allowsMock() ? <SampleSitesScreen /> : <RealSites />;
}
