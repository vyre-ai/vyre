// The Search place (the map's "Find", /u/search): the whole of Find on a page, on every device. The query can arrive as ?q=.
import { useLocalSearchParams, useRouter } from "expo-router";
import { Page } from "../places/Frame";
import { FindPanel } from "./FindPanel";

export function FindScreen() {
  const router = useRouter();
  const { q } = useLocalSearchParams<{ q?: string }>();
  return (
    <Page title="Search" back="/u">
      <FindPanel initial={typeof q === "string" ? q : ""} autoFocus onGo={(href) => router.push(href as never)} />
    </Page>
  );
}
