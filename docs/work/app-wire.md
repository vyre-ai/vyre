# app-wire

## Scope
Connect the 0.3 app's Vault, Memory (graph, pins, corrections), Flows (start, a run's record) and Drive screens to a real vyred through the app's box connection (src/api/box call/send, POST /v1/tools/<name>). No new transport. The sample world stays behind EXPO_PUBLIC_VYRE_MOCK=1. Branch work/app-wire off work/ui 5832dde23; native-core merges it.

## Done
- Vault: RealVault.tsx, source.ts (calls over an injected `call`), real-model.ts, real.ts, test real.test.js (9 of 9 on the test box). Against the dev box (the dev box, via `vyre call`, the same tools the app calls): vault.list answered with an empty vault, vault.uses answered empty, vault.reveal and vault.put refused as human-only (no_terminal from the CLI). I could not seed an item: vault.put needs a person. So Reveal on a real item with a real proof is NOT yet seen.
- Memory extras: RealExtras.tsx (RealAsk, map with Pin/Never offer, What you corrected with Undo), extras-source.ts, extras-model.ts, extras.ts, test extras.test.js (11 of 11 in screens/memory on the test box, with native-core's real-model test). Against the dev box via `vyre call`: memory.graph answered the empty floor plan in the shape the screen reads, memory.corrections [], memory.ask abstained with no answer. The dev box has no facts and memory.correct add is human-only from the CLI, so Pin, Undo and a real answer are NOT yet seen on real data.
- Flows: run-source.ts, run-model.ts, run.ts, test run.test.js (9 of 9 in screens/flows on the test box, with the existing logic test); RealFlow.tsx gets Run now (flows.start), a run record (the painted nodes as lines) and Retry (flows.retry). Against the dev box: flows.list answered [] and flows.kit.list [], so there is no Flow there to start; flows.define needs a type in the space (records_driver_missing on that box). Run now, the record and Retry are NOT yet seen on a real Flow.
- Drive: RealDrive.tsx, source.ts, real-model.ts, real.ts, test real.test.js (8 of 8 in screens/drive on the test box). Against a real files module (a scratch vyred of the dev checkout on the dev machine, with a folder as files.roots and files.drive.shares, since the dev box has no /work and no folder; removed after): files.drive.status, list (root and a subfolder) and read answered in exactly the shapes the screen reads, a text file decoded to its words by the app's own decoder, and a ".." path refused as bad_input. Not on chat's dev box itself: its share "projects" points at /work, which does not exist there (not_available).

## Doing
- Nothing open. Waiting on native-core to merge.

## Next
- Drive (files.drive.list and files.drive.read): the dev box answers not_available for share "projects" (the share is offered but not shared, Taildrive policy missing).

## Needs
- The owner or chat: one real vault item on the dev box (a person runs `vyre vault put` there, as in CHAT.md), so Reveal can be walked.
- chat: Drive on the dev box needs a folder in files.roots and files.drive.shares in its config.json (and a restart, which is yours).
- platform: no files write tool exists (upload) and no version history tool; Drive does not offer either.
