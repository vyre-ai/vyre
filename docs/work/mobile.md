# mobile

Branch: work/mobile · Worktree: ../vyre-mobile · ADR 0015

## Scope

Owns `apps/ios/`, `apps/android/`, `apps/CONTRACT.md`, `apps/RELEASE.md`, `apps/test/`. Native
iPhone and Android apps for the Deck, Chat and the Capsule: Now (held drafts edited in place),
Chat (projects, sessions, the terminal mirrored, streaming, sending, the lease), a mobile Capsule
(one search box, ask the assistant, @agent, tell or watch a session, voice), Files, Agents,
Memory, Vault (reveal and copy only after presence on this device), Settings, and native push.

Small changes outside the scope, each through the owner's contract and listed below:
`core/presence` (a `device` method), `core/modules` (a `tailnet` callers entry), `core/push`
(native transports), `deck/onboard/device/` (the sign-in page the app opens).

## Plan

1. ADR 0015 and the client contract (`apps/CONTRACT.md`). Done.
2. Server side, in parallel with the apps: the `device` presence method and its tests; a
   `tailnet` entry in `callers` lists for the people-only tools; `deck/onboard/device/`;
   `apps/test/world.js`, a temp-home vyred with the fictional world behind a plain HTTP proxy the
   simulator and emulator reach.
3. iOS (SwiftUI, XcodeGen project, no packages) and Android (Compose, Gradle, OkHttp), each: API
   client + SSE reader + device-key presence, then Now, Chat, Capsule, then Agents, Memory, Vault,
   Files, Settings. Unit tests for the client pieces, then screenshots of every screen against the
   test world.
4. Native push: `core/push` APNs and FCM transports with a sealed path, the iOS service
   extension, the Android messaging service. Tested against a fake APNs/FCM server.
5. Release steps written down for the user (`apps/RELEASE.md`).

## Done
- ADR 0015, claimed in docs/work/README.md. `apps/CONTRACT.md` from the code at d1f7b75.

## Doing
- Server side, iOS and Android, in parallel.

## Next
- Share sheet in and out, Taildrop (tailnet team), widgets and Live Activities (later).

## Needs from others
- lead: the push relay decision for store builds (ADR 0015 section 4); until then push works
  with the owner's own APNs/FCM keys in the Vault.
- link or tailnet: a way for the box to call the Mac (box-to-Mac `link.remote`), so the phone
  sees the Mac's files and sessions. Without it the phone reaches the box only.
- link: a `files.put` (or the Glass ticketed upload as a tool), for share-sheet-in.
- security: review of the `device` presence method.
- switchboard: review of the push transports; a `thread.status` event would save a re-read.

## Changed contracts
- (filled in as each lands)
