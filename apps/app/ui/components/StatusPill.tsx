import { Chip } from "./Chip";

/**
 * The one pill for where a thing is: neutral, with how far along it is ("Stage 2 of 5"), never a colour per stage. `needsYou` is the only violet one ("Needs you"): it says the person has to act.
 * Used by the Projects list, the project page's header strip and the Playbooks board. `name` adds the stage's own name after the progress.
 */
export function StatusPill({ at, of, name, needsYou }: { /** 1-based position */ at: number; of: number; name?: string; needsYou?: boolean }) {
  if (needsYou) return <Chip tone="accent">Needs you</Chip>;
  return <Chip>{`Stage ${at} of ${of}${name ? `: ${name}` : ""}`}</Chip>;
}
