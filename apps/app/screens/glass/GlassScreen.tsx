// An agent's computer, full screen, or the server's files (the target "box").
// The computer is an overlay over the window (ComputerHost). This route only opens it. Closing it leaves the route.
import { useEffect } from "react";
import { Platform } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { Card, EmptyState } from "@vyre/ui";
import { Frame } from "../places/Frame";
import FilesTab from "./FilesTab";
import { closeComputer, openComputer } from "./computer-open";

export default function GlassScreen() {
  const { name: raw } = useLocalSearchParams<{ name: string }>();
  const name = String(raw ?? "");
  const server = name === "box";
  if (Platform.OS !== "web") {
    return <Frame title="Computer" sub="Watch an agent's computer."><Card><EmptyState title="Computer opens in the browser" body="Open Vyre in a browser on your computer to watch, take over and browse files." /></Card></Frame>;
  }
  return server ? <ServerFiles /> : <Computer name={name} />;
}

/** The server's folders. It has no screen. */
function ServerFiles() {
  return <Frame title="Your server" sub="Files in the folders you chose for Glass. Your server has no screen."><FilesTab target="box" name="box" /></Frame>;
}

function Computer({ name }: { name: string }) {
  useEffect(() => {
    if (!name) return;
    openComputer(name, true);
    return () => closeComputer(name);
  }, [name]);
  return null;
}
