---
title: Answering control
summary: One control for which AI replies: stacked provider marks and the words, opening the Answering list for one, several or all, and each one's model.
audience: builders
owner: app-design
status: draft
---

# Answering control

Replaces the per-AI model dropdowns and "Ask all". Shows up to three provider marks, overlapping by 8, and the summary ("Claude", "Claude and Codex", "Everyone"). Press, or Cmd/Ctrl and `/`,
opens the Answering list: Everyone (Alt 0), each AI (Alt 1 to 9, toggles it) and, below, a model row per AI that opens that AI's model list with its fit score. A chat with one AI shows its
model name and the same list. The choice applies to the next message and then goes back to the default. Where it runs and send now or queue live in the `+` menu and appear as a chip only when they differ.

| Surface | Implementing file | Status |
|---|---|---|
| App | `apps/app/ui/components/AnsweringControl.tsx`, `answeringSummary` and `toggleAnswering` in `apps/app/ui/lib/picker-model.js` | built |
