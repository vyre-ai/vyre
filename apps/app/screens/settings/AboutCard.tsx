import { View } from "react-native";
import { Text, VyreMark } from "@vyre/ui";
import { StarButton } from "./StarOnGithub";

/** About's top: the Vyre mark with the version, and the Star button. Both About screens (sample and real) show it. */
export function AboutCard({ version }: { version?: string | null }) {
  return (
    <View className="items-start gap-s3">
      <View className="flex-row items-center gap-s3">
        <VyreMark size="md" />
        <View>
          <Text size="title" strong>Vyre</Text>
          {version ? <Text tone="muted">{`Version ${version}`}</Text> : null}
        </View>
      </View>
      <StarButton />
    </View>
  );
}
