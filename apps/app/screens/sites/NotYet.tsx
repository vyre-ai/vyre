import { Card, EmptyState } from "@vyre/ui";
import { Frame } from "../places/Frame";

/** Publishing is not in this release: a deep link to a Sites page lands here instead of on controls that would not be supported. */
export function NotYet() {
  return <Frame title="Sites" sub="Publishing arrives in the next release."><Card><EmptyState title="Not in this release" body="Publishing a site from Vyre comes in the next release." /></Card></Frame>;
}
