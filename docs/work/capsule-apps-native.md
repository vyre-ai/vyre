# capsule-apps-native

Scope: `@` inside an app in the native Capsule. The user types "@Wha", Tab makes WhatsApp the chip;
"@ju" then lists contacts inside WhatsApp (from that extension), Tab makes "WhatsApp › juno"; the
rest of the text is the message and Enter sends it to juno, with WhatsApp known as the parent.
Branch `work/capsule-apps-native`, based on capsule-pro's c6b2d45. Everything here is for
capsule-pro to review and merge; the Host, Route-adjacent model and view edits are kept small.

## Done

- Kit: nesting one level deep, an async second answer for `@`, and a pick hook (below).
- Host, model, panel key and chip view wired to them. `Tests/ExtensionNestTests.swift`
  (suite "extension nesting", 14 tests) with a fake `ChatProbe`; NotesProbe and sight unchanged.

## Changed contracts (for capsule-pro)

All additions to `Sources/Kit/Extension.swift`, each with a default, so an extension written
against c6b2d45 compiles and behaves the same:

- `MentionTarget` gains `nests: Bool` (default false) and `parentID: String?` (default nil), as
  trailing init parameters with defaults. `nests == true` means picking it makes a chip under
  which a second `@` asks the same extension for children. Nesting stops at two levels.
- `public struct MentionContext: Sendable, Equatable { parent: MentionTarget?; extensionID: String? }`
  with `MentionContext.top` for "no chip". `parent` is the current chip when it belongs to the
  extension being asked; `extensionID` is that chip's extension.
- `mentions(matching:context:) -> [MentionTarget]`: the Capsule calls this one. Default:
  `context.parent == nil ? mentions(matching:) : []`.
- `refreshMentions(matching:context:) async -> [MentionTarget]?`: default nil, asked only when the
  extension says `refreshesMentions == true` (default false, read once at load, so extensions
  without one cost no task per key). The model calls it once, 120 ms after the last keystroke,
  only while shown; extensions run side by side and each answer is applied as it lands; the next
  keystroke and hide cancel it; an answer is dropped unless the search, the words and the chip
  are still the ones it was asked for. No polling.
- `mentionPicked(_:context:)`: default no-op, called once when a target becomes the chip (an app
  chip can prefetch its contacts into memory).
- `send(_:to:in:query:) async -> ActionOutcome`: the Capsule calls this one, with the chip the
  child was picked under (or nil). Default forwards to `send(_:to:query:)`.

Capsule side (internal, capsule-pro's files):

- `CapsuleModel`: `targetParent` (the outer chip of a two-level chip; `target`'s didSet clears it
  whenever `target` is not its child, so old callers setting `target` stay correct), `shown`
  (willShow to didHide; refreshMentions and searchSessions do nothing outside it), `childID`
  (parent and child ids joined with NUL, collision-free), `refreshScheduled`, `nestingChip`,
  `dropChip()` (delete on an empty box: child first, then the chip), `listMentions`,
  `refreshMentions(_:token:)`, `cancelMentionRefresh`, `mentionIcon(_:)`. Refreshed rows are
  forgotten on hide, reset and any non-`@` search. `extensionMentions` now takes the nesting chip;
  new closures `extensionRefreshers` and `extensionPicked`; `sendToExtension` also takes the parent.
  With a nesting chip, Vyre's agents, projects and sessions are not listed and projects.catalog is
  not asked.
- `ExtensionHost`: `ExtensionMention` (ext id, candidate, target); `mentions(_:parent:)`,
  `refreshers(_:parent:)`, `picked(_:parent:)`. A child's candidate id is
  `CapsuleModel.childID(chip id, child id)`, so the same contact under two apps stays two targets.
- `Panel`: delete on an empty box calls `model.dropChip()`. `key(_:)` is internal, not private,
  so a test drives it with an `NSEvent.keyEvent` (never posted) on a panel never shown.
- `CapsuleView`: the chip draws the extension's icon (an app's own) and "WhatsApp › juno".

## Doing

Nothing.

## Next

- capsule-apps (the extension itself) builds WhatsApp and friends on this seam.
- Snapshot of the two-level chip in SnapshotTests once capsule-pro has merged the view change.

## Needs from others

- capsule-pro: review and merge the Kit additions and the Host/model/view edits.
