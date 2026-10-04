# app-wire

## Scope
Connect the 0.3 app's Vault, Memory (graph, pins, corrections), Flows (start, a run's record) and Drive screens to a real vyred through the app's box connection (src/api/box call/send, POST /v1/tools/<name>). No new transport. The sample world stays behind EXPO_PUBLIC_VYRE_MOCK=1. Branch work/app-wire off work/ui 5832dde23; native-core merges it.

## Done
- Vault: RealVault.tsx, source.ts (calls over an injected `call`), real-model.ts, real.ts, test real.test.js (9 of 9 on the test box). Against the dev box (the dev box, via `vyre call`, the same tools the app calls): vault.list answered with an empty vault, vault.uses answered empty, vault.reveal and vault.put refused as human-only (no_terminal from the CLI). I could not seed an item: vault.put needs a person. So Reveal on a real item with a real proof is NOT yet seen.

## Doing
- Memory graph, pins, corrections.

## Next
- Flows start and a run's record (native-core already has list, graph, card, approve, runs, pause).
- Drive (files.drive.list and files.drive.read): the dev box answers not_available for share "projects" (the share is offered but not shared, Taildrive policy missing).

## Needs
- The owner or chat: one real vault item on the dev box (a person runs `vyre vault put` there, as in CHAT.md), so Reveal can be walked.
- chat: Drive needs a shared folder on the dev box, or tell me how to make files.drive.list answer there.
