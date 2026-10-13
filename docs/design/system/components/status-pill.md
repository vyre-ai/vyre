---
title: Status pill
summary: The one neutral pill for where something is in its stages ("Stage 2 of 5"), and the one violet variant that says it needs you.
audience: builders
owner: app-design
status: draft
---

# Status pill

A Chip with a fixed reading. Neutral (fill `--hover`, text `--text-2`) and always the same: "Stage 2 of 5", with the stage's own name after a colon where there is room ("Stage 2 of 5: Engagement"). No colour per stage. `needsYou` turns it violet ("Needs you"): violet means a person has to act, and nothing else is violet.

| Surface | Implementing file | Status |
|---|---|---|
| App | `apps/app/ui/components/StatusPill.tsx`; used by the Projects list (`ui/tasks/ProjectsList.tsx`) and the project page's header strip (`screens/projects/ProjectHeaderStrip.tsx`) | built |
