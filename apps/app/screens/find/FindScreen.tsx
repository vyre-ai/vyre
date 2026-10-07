// /u/search: Find as a page, on every device. On the phone it is the search button at the top right (or pull down); on desktop and the web, Cmd-K opens the same thing as a command bar (FindHost).
import { useLocalSearchParams } from "expo-router";
import { Frame } from "../places/Frame";
import FindPanel from "./FindPanel";

export default function FindScreen() {
  const { q } = useLocalSearchParams<{ q?: string }>();
  return <Frame title="Search" sub="Find a chat, a project, a person, a file or a memory, or ask."><FindPanel initial={typeof q === "string" ? q : ""} /></Frame>;
}
