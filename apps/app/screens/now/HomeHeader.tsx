import { View } from "react-native";
import { Text } from "@vyre/ui";
import { dateLine, greeting, summary } from "./home-model.js";

/** The top of Home: the date, the greeting and one line on what needs the person. */
export function HomeHeader({ name, now, waiting, working, today, zone }: { name?: string; now: number; waiting?: number; working?: number; today?: number; zone?: string }) {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, ...(zone ? { timeZone: zone } : {}) }).format(new Date(now))) % 24;
  return (
    <View className="gap-s1 pb-s3">
      <Text size="caption" tone="label">{dateLine(now, zone)}</Text>
      <Text size="page" strong>{greeting(hour, name)}</Text>
      <Text tone="muted">{summary({ waiting, working, today })}</Text>
    </View>
  );
}
