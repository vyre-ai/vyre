import { BlockScreen } from "@vyre/ui";
import "./register";
import { recordsScreen } from "./records-screen.js";

/** /u/records/<type>: the records page, described as a screen (one `records` block) and drawn by the one renderer. */
export function RecordsScreen({ type, view }: { type: string; view?: string }) {
  return <BlockScreen screen={recordsScreen(type, view) as never} page />;
}
