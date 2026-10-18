import { View } from "react-native";
import { useRouter } from "expo-router";
import { Button, Card, Divider, EmptyState, IconTile, Row, type IconName } from "@vyre/ui";
import { Frame } from "../places/Frame";
import { useSidebar } from "../shell/sidebar";
import { appTiles, MAKE_AN_APP_HREF } from "./model.js";

/** Apps: the apps this Space has, one row each; an app opens its own screens. "Make an app" starts an Engineer chat. */
export function AppsHome() {
  const router = useRouter();
  const modules = useSidebar((s) => s.modules);
  const tiles = appTiles(modules);
  return (
    <Frame title="Apps" sub="What this Space has installed." top actions={<Button label="Make an app" icon="plus" onPress={() => router.push(MAKE_AN_APP_HREF as never)} />}>
      {tiles.length === 0 ? (
        <EmptyState title="No apps yet" body="Ask Engineer to make one, and it shows here." action={{ label: "Make an app", onPress: () => router.push(MAKE_AN_APP_HREF as never) }} />
      ) : (
        <View>
          <Card flush>
            {tiles.map((t, i) => (
              <View key={t.id}>
                {i > 0 ? <Divider inset={60} /> : null}
                <Row lead={<IconTile name={t.icon as IconName} />} title={t.title} sub={t.sub} chevron onPress={() => router.push(t.href as never)} />
              </View>
            ))}
          </Card>
        </View>
      )}
    </Frame>
  );
}
