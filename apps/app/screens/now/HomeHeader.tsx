import { View } from "react-native";
import { Text } from "@vyre/ui";
import { dateLine, greeting } from "./home-model.js";

/** The top of Home: the date, then the greeting. `updating`: Home is drawn from this device's last copy while the computer answers, said quietly on the date line so nothing moves. */
export function HomeHeader({ name, now, zone, updating }: { name?: string; now: number; zone?: string; updating?: boolean }) {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, ...(zone ? { timeZone: zone } : {}) }).format(new Date(now))) % 24;
  return (
    <View className="gap-s1">
      <Text size="caption" tone="muted">{updating ? `${dateLine(now, zone)} · Updating` : dateLine(now, zone)}</Text>
      <Text size="page" strong>{greeting(hour, name)}</Text>
    </View>
  );
}
