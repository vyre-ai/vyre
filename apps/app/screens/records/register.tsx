// The app's own block types, registered once: the `records` block draws the records views (they need the app's store and router, so they live here and not in @vyre/ui).
import { registerBlock } from "@vyre/ui";
import { RecordsBlock } from "./RecordsBlock";

registerBlock("records", (p) => <RecordsBlock {...p} />);
