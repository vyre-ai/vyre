import { Chip } from "./Chip";

/** The small tag that says where a thing lives: "Personal - Home", "Personal - Cloud" or a team space's name. One chip (no new pill): the words come from placeTag in src/state/space-name.js. */
export function SpaceTag({ text }: { text: string }) {
  return <Chip>{text}</Chip>;
}
