# Perf meter

`meter.js` is the app's frame meter and metric recorder. It has no DOM, React or React Native imports: callers push timestamps in ms and it keeps bounded rings (the last 2,000 frames, the last 500 samples per name), so it never grows. See [ADR 0027](../../../docs/adr/0027-one-app.md).

## What it measures

- Frames: fps, dropped frames (an interval over 1.5 refresh periods drops `round(interval / period) - 1`), worst and p95 frame time over a window.
- Named metrics from `mark` and `measure`, or `record` for values that are not durations.
- Gaps: time between successive calls of `gap(name)`, such as visible stream updates.
- A check's stat is `p50`, `p95` or `max` of a name's samples, or `cv` (their coefficient of variation).
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

The session screen (`app/session/[id].tsx`, `src/session/`) marks the native bar's metrics. "After the paint" is a task posted from the frame callback that published the change (`thisPaint`), or from the next frame after a key or tap (`nextPaint`), so it lands just after that frame painted:

- `keystroke`: the input event's time to after the next paint, while typing in the composer.
- `stream.first`: a reply's first event arriving from the stream to after the paint that shows its first characters.
- `stream.box`: the box's stamp `t` on that first `thread.text` (epoch ms) to the same paint. Skipped when the event has no `t`; the clock offset is 0 until the box offers a time to sync against.
- `stream.cpf`: characters each streaming reply revealed per frame while it had a backlog (the one frame clock in `src/session/store.ts` over chat core `pace.js`). The check is its coefficient of variation.
- Gap `stream` (session screen): each frame a reply's reveal moved; a run ends when the reply is done.
- `cls`: layout-shift entries (no recent input) whose sources are rows above the live row, the last one. A 0 goes in when the transcript mounts, so a clean run is judged.
- `view.jump`: while the reader is up in history, what is left of a move after the anchor row is put back, before the paint.
- `open.session.cache` and `open.session.cold`: the tap in Chats or Needs (or the screen's mount) to after the paint of its rows, from this device's view cache (or a session kept alive), or from the box.
- `send.paint`: Send to after the paint of the user row.
- `stop.paint`: Stop (or Esc) to after the paint of the state chip saying "stopping".

## The native bar

The checks with an `nb` in `BAR` are the budgets of `docs/design/native-bar.md`, and `nb` is the number of the budget's row in its table: `keystroke` 1, `firstToken` 2, `boxToScreen` 3, `streamCV` and `streamGapBar` 4, `cls` and `viewJump` 5, `openSessionCache` and `openSessionCold` 7, `send` 9, `stop` 10. One harness: the Deck's `deck/test/native-bar/` and this meter judge the same rows by the same numbers. `streamGap` (50 ms) stays as the phone's stricter check from ADR 0027; `streamGapBar` is the native bar's 250 ms. Rows 6 (fling), 8 (reconnect) and 11 (idle timers) are judged by the frame meter (`scroll`) and the harness's own scripts.

## Numbers of record

The numbers of record are taken on a real iPhone 12 (iOS 18) and a Pixel 6a, installed app, direct over Tailscale. CI numbers (Chrome, 4x CPU throttle) are a regression guard only.

Test: `node --test apps/app/perf/meter.test.js`
