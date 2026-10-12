// The small tag on a screen's title area and on items: where this lives. "home": the screen shows her own home's things (Personal - Home or Personal - Cloud); "showing": the space showing (a team's name);
// or a space id for a thing that carries its own. Nothing is drawn until the spaces are known.
import { useEffect } from "react";
import { View } from "react-native";
import { SpaceTag } from "@vyre/ui";
import { useMembers } from "../../screens/spaces/state";
import { useSpaces } from "../../screens/shell/state";
import { tagFor } from "./place-tag.js";

export function PlaceTag({ of = "showing" }: { of?: string }) {
  const cards = useMembers((s) => s.spaces);
  const load = useMembers((s) => s.load);
  const showing = useSpaces((s) => s.space);
  useEffect(() => { if (!cards.length) void load(); }, [cards.length, load]);
  const text = tagFor(cards, of, showing);
  return text ? <View className="flex-row"><SpaceTag text={text} /></View> : null;
}
