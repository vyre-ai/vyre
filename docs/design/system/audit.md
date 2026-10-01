---
title: The render audit
summary: The check every design board passes, how to run it locally and in CI, and what it does not catch.
audience: builders
owner: app-design
status: draft
---

# The render audit

Every board on the canvas is a file in `docs/design/one-app/project/`. The audit renders each one in
headless Chrome and fails it on:

- any text under WCAG AA against its real, composited background (4.5:1, or 3:1 at 24 px and up);
- any text outside its frame, or cut off by a clipping parent (a button or card with overflow
  hidden), unless it ends in an ellipsis or a line clamp on purpose, or sits in a row drawn
  mid-swipe (`data-clip-ok`);
- any text size off the scale (12, 13, 15, 17, 20, 22, 28), any weight but 400 and 600, any family
  but Instrument Sans and JetBrains Mono. The one exception is the hero line of the launch art (Og,
  Social, ReadmeHero), marked `data-display-type`, which may be larger than 28;
- any text, fill or border colour that is not a token.

Dark boards render their own theme; each `-paper` board renders the same board in paper.

## Run it

```
npm run design:audit                 # every board
node scripts/design-audit Needs Plan # some boards
CHROME=/path/to/chrome npm run design:audit
```

It prints one line per board and exits 1 if any fails. The web fonts load from Google Fonts, so it
needs the network for exact metrics.

In CI the design workflow (`.github/workflows/design.yml`) runs on any change to the boards, the
system docs, the tokens or the generator: `gen-tokens --check`, the token and theme tests, then the
audit.

## What it does not catch

The audit is a floor, not a review. It cannot tell whether a layout reads well, whether a primary
is the right action, or whether copy follows [Copy](copy.md). Look at every PNG you change
(`docs/design/one-app/render/render.sh` writes them), and keep one primary per surface, violet only
for needs you, and 44 px touch targets by eye.

It also checks boards, not the running code. Each surface keeps its own tests for its components;
the component specs' Gaps sections are what those tests should close.
