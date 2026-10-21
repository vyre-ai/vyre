import { View } from "react-native";
import { Text } from "@vyre/ui";
import { ASSISTANT_MARK } from "../../src/store-core/kernel-view.js";
import { ActorMark } from "../../ui/tasks/ActorMark";
import { Section } from "../../ui/tasks/Section";
import { nowModel, whenLabel, who, type World } from "../../ui/tasks/model";
import { useNowScope } from "../../ui/tasks/scope";
import { useSnoozed } from "../../src/state/snooze";

/** Recent on Home: the latest things that happened, on every width. */
export function HomeRecent({ world }: { world: World }) {
  const { scope } = useNowScope(world);
  const later = useSnoozed(world.now);
  const recent = nowModel(world, scope, later).recent;
  return (
    <Section title="Recent">
      {recent.length ? (
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
      ) : <Text tone="label">Nothing has happened yet.</Text>}
    </Section>
  );
}
