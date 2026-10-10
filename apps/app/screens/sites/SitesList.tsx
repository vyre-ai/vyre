// The list of sites in this space: one list block, each row a site, what is live and where, and where it stands. Tapping a row opens the site. A site waiting on you is a chip; the rest say their state plainly.
import { BlockScreen, type BlockScreenData } from "@vyre/ui";
import { siteRows, type Site } from "./real-model";

export function SitesList({ rows, onOpen }: { rows: Site[]; onOpen: (name: string) => void }) {
  const screen: BlockScreenData = { v: 2, id: "sites", layout: { block: "sites" }, blocks: { sites: { type: "list", props: { density: "tight" }, content: { rows: siteRows(rows) } } } };
  return <BlockScreen screen={screen} handlers={{ open: (_b, row) => onOpen(String(row.id)) }} />;
}
