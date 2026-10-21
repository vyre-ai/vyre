import { Chip } from "@vyre/ui";
import { tagOfChip } from "../../ui/tags/model.js";
import { tagViews, toggleTag } from "./tag-views.js";

/** Tags on these rows, as chips beside the saved views. Picking one filters the list by that tag. */
export function TagViewChips({ rows, chips, onChips }: { rows: { data?: Record<string, unknown> }[]; chips: { field: string; op: string; operand?: unknown }[]; onChips: (next: { field: string; op: string; operand?: unknown }[]) => void }) {
  const views = tagViews(rows);
  if (!views.length) return null;
  return (
    <>
      {views.map((v) => (
        <Chip key={v.tag} selected={chips.some((c) => tagOfChip(c) === v.tag)} onPress={() => onChips(toggleTag(chips, v.tag))}>{v.label}</Chip>
      ))}
    </>
  );
}
