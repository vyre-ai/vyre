import { View } from "react-native";
import { Text } from "@vyre/ui";
import { ASSISTANT_MARK } from "../../src/store-core/kernel-view.js";
import { ActorMark } from "../../ui/tasks/ActorMark";
import { nowModel, whenLabel, who, type World } from "../../ui/tasks/model";
import { useNowScope } from "../../ui/tasks/scope";
import { useSnoozed } from "../../src/state/snooze";
import { HomeSection } from "./HomeSection";

/** Recent on Home: the latest things that happened. Hidden when nothing has. */
export function HomeRecent({ world }: { world: World }) {
  const { scope } = useNowScope(world);
  const later = useSnoozed(world.now);
  const recent = nowModel(world, scope, later).recent;
  if (!recent.length) return null;
  return (
    <HomeSection title="Recent" count={recent.length}>
      <View>
        {recent.map((e) => {
          const a = who(world, e.actor);
          const name = e.actor === world.me ? "You" : a?.family === "person" ? a.name.split(" ")[0] : a?.name || "Vyre";
          return (
            <View key={e.id} className="min-h-control flex-row items-center gap-s3 py-s1">
              <ActorMark who={a} size="sm" />
              <Text size="secondary" className="min-w-0 flex-1" numberOfLines={1}>{`${name}${e.via ? ` ${ASSISTANT_MARK}` : ""} ${e.what}`}</Text>
              <Text mono size="caption" tone="faint">{whenLabel(e.at, world.now)}</Text>
            </View>
          );
        })}
      </View>
    </HomeSection>
  );
}
