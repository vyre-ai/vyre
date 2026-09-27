# Perf meter

`meter.js` is the app's frame meter and metric recorder. It has no DOM, React or React Native imports: callers push timestamps in ms and it keeps bounded rings (the last 2,000 frames, the last 500 samples per name), so it never grows. See [ADR 0027](../../../docs/adr/0027-one-app.md).

## What it measures

- Frames: fps, dropped frames (an interval over 1.5 refresh periods drops `round(interval / period) - 1`), worst and p95 frame time over a window.
- Named metrics from `mark` and `measure`, or `record` for values that are not durations.
- Gaps: time between successive calls of `gap(name)`, such as visible stream updates.
- Long tasks: main thread task durations.

`report()` returns plain JSON with a `verdict` that checks each `BAR` entry. A check with no samples has `pass: null`.

## How it is fed

- Web: a requestAnimationFrame loop calls `frame(t)`, but only while the `?perf=1` overlay is on and the page is visible, so it costs nothing otherwise. Long tasks come from PerformanceObserver where the browser has it, otherwise from rAF gaps.
- Native: Reanimated `useFrameCallback` on the UI thread calls `frame(t)`.

## Where each metric is marked

- `tab.switch`: tab press to the first frame with the new tab's content.
- `open.cold`: `performance.timeOrigin` to Needs drawn.
- `open.warm`: `visibilitychange` (or app state active) to Needs drawn.
- `approve.collapse`: swipe commit to the frame the row collapses.
- `keyboard.jump`: the transcript's last row screen y before and after the keyboard animates, recorded as absolute px.
- Gap `stream`: each visible text update while a reply streams.
- Long tasks: recorded while a stream is live; the check is judged once something streamed.
- `term.echo`: key down to the echoed glyph on screen.

## Numbers of record

The numbers of record are taken on a real iPhone 12 (iOS 18) and a Pixel 6a, installed app, direct over Tailscale. CI numbers (Chrome, 4x CPU throttle) are a regression guard only.

Test: `node --test apps/app/perf/meter.test.js`
