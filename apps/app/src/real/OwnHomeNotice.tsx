// A line at the top of a screen that shows her own home while a joined team is showing: it says so, and one tap shows what the team's side holds for her (src/real/own-home.js).
import { useEffect, useState } from "react";
import { View } from "react-native";
import { Banner, Button, Text } from "@vyre/ui";
import { showingJoined } from "./team-join";
import { noteFor } from "./own-home.js";

export function OwnHomeNotice({ screen }: { screen: string }) {
  const [joined, setJoined] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => { void showingJoined().then(setJoined).catch(() => setJoined(false)); }, []);
  const note = noteFor(screen);
  if (!joined || !note) return null;
  return (
    <Banner>
      <View className="gap-s2">
        <Text strong>{note.title}</Text>
        <Text>{note.body}</Text>
        {open ? <Text tone="muted">{note.team}</Text> : null}
        <View className="flex-row"><Button kind="ghost" size="sm" label={open ? "Hide the team's" : "See the team's"} onPress={() => setOpen(!open)} /></View>
      </View>
    </Banner>
  );
}
