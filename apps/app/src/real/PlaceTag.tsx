// The small tag on a screen's title area and on items: where this lives. "home": the screen shows her own home's things (Personal - Home or Personal - Cloud); "showing": the space showing (a team's name);
// or a space id for a thing that carries its own. Nothing is drawn until the spaces are known.
import { useEffect } from "react";
import { View } from "react-native";
import { SpaceTag } from "@vyre/ui";
import { useMembers } from "../../screens/spaces/state";
import { useSpaces } from "../../screens/shell/state";
import { tagFor } from "./place-tag.js";

/** The tag's words for a list that came from one place: her own home's, or the space showing. Null until the spaces are known (and under All spaces, where each row carries its own). */
export function usePlaceText(of: string = "showing"): string | null {
  const cards = useMembers((s) => s.spaces);
  const load = useMembers((s) => s.load);
  const showing = useSpaces((s) => s.space);
  useEffect(() => { if (!cards.length) void load(); }, [cards.length, load]);
  return tagFor(cards, of, showing);
}

export function PlaceTag({ of = "showing" }: { of?: string }) {
  const text = usePlaceText(of);
  return text ? <View className="flex-row"><SpaceTag text={text} /></View> : null;
}
