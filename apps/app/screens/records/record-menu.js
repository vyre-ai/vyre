// @ts-check
// The record page's More menu, in order. Pure, so the screen only fills in what each choice does.

/**
 * Copy and the two view switches first, then the rare actions, then Delete.
 * Show empty fields is hidden while the agent preview is on (the old switch was too).
 * @param {{ id?: string, agent?: boolean, canAgent?: boolean, showEmpty?: boolean, files?: boolean, dial?: boolean }} flags
 * @returns {{ id: string, label: string, selected?: boolean, danger?: boolean, divider?: boolean }[]}
 */
export function recordMenu(flags) {
  /** @type {{ id: string, label: string, selected?: boolean, danger?: boolean, divider?: boolean }[]} */
  const items = [];
  if (flags.id) items.push({ id: "copy-id", label: "Copy ID" });
  items.push({ id: "copy-link", label: "Copy link" });
  if (flags.canAgent) items.push({ id: "agent", label: "Preview what your agent sees", selected: !!flags.agent });
  if (!flags.agent) items.push({ id: "empty", label: "Show empty fields", selected: !!flags.showEmpty });
  /** @type {{ id: string, label: string, divider?: boolean }[]} */
  const rare = [];
  if (flags.files) rare.push({ id: "files", label: "Open files" });
  if (flags.dial) rare.push({ id: "dial", label: "Call the number" });
  rare.push({ id: "header", label: "Edit header" });
  const lead = rare[0];
  if (lead) lead.divider = true;
  items.push(...rare, { id: "delete", label: "Delete", danger: true, divider: true });
  return items;
}
