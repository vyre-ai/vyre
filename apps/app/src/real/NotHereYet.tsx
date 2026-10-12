import { View } from "react-native";
import { Text } from "@vyre/ui";
import { PlaceTag } from "./PlaceTag";

/** The words a member sees where a team's screen has no door call for her yet: the place it is for, and one plain sentence. */
export function NotHereYet({ what }: { what: string }) {
  return <View className="gap-s2"><PlaceTag /><Text tone="muted">{`${what} is not in your app yet. The owner sees it.`}</Text></View>;
}

/** Was this refusal the "the team's side has no call for a member yet" one? */
export const isNotHere = (e?: { code?: string; message?: string }) => Boolean(e && e.code === "not_allowed" && /owner's for now/.test(e.message ?? ""));
