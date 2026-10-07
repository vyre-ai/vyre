// The frame of a settings-style page: an optional Back, a title and sub line, actions at the end, then the body in a column that stops at the page width.
import { ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import { Button, Text } from "@vyre/ui";

export function Page({ title, sub, back, actions, children }: { title: string; sub?: string; back?: string; actions?: React.ReactNode; children: React.ReactNode }) {
  const router = useRouter();
  return (
    <ScrollView className="flex-1" contentContainerClassName="w-full max-w-page gap-s4 self-center p-s4 pb-s12">
      {back ? <View className="flex-row"><Button kind="ghost" size="sm" icon="chevron-left" label="Back" onPress={() => router.push(back as never)} /></View> : null}
      <View className="flex-row items-end gap-s3">
        <View className="min-w-0 flex-1 gap-s1">
          <Text size="page" strong>{title}</Text>
          {sub ? <Text tone="muted">{sub}</Text> : null}
        </View>
        {actions ? <View className="flex-none flex-row flex-wrap justify-end gap-s2">{actions}</View> : null}
      </View>
      {children}
    </ScrollView>
  );
}

/** A small label over a group of rows. */
export function Group({ title, note, children }: { title?: string; note?: string; children: React.ReactNode }) {
  return (
    <View className="gap-s2">
      {title ? <View className="flex-row items-baseline gap-s2"><Text size="caption" strong tone="label">{title}</Text>{note ? <Text size="caption" tone="faint">{note}</Text> : null}</View> : null}
      {children}
    </View>
  );
}
