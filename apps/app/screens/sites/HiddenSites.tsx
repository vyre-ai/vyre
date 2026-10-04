import { useRouter } from "expo-router";
import { EmptyState } from "@vyre/ui";
import { Frame } from "../places/Frame";
import { HIDDEN } from "../shell/rc";

/** /u/sites and a site's page while Publish is left out of the release (0.3.1): an old link says so and goes home. */
export default function HiddenSites() {
  const router = useRouter();
  return <Frame title="Sites" top><EmptyState title={HIDDEN.sitesTitle} body={HIDDEN.sitesBody} action={{ label: HIDDEN.sitesAction, onPress: () => router.replace("/u/now" as never) }} /></Frame>;
}
