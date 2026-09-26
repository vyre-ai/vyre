# capsule-apps-native

Scope: `@` inside an app in the native Capsule. The user types "@Wha", Tab makes WhatsApp the chip;
"@ju" then lists contacts inside WhatsApp (from that extension), Tab makes "WhatsApp › juno"; the
rest of the text is the message and Enter sends it to juno, with WhatsApp known as the parent.
Branch `work/capsule-apps-native`, based on capsule-pro's c6b2d45. Everything here is for
capsule-pro to review and merge; the Host, Route-adjacent model and view edits are kept small.

## Done

- Kit: nesting one level deep, an async second answer for `@`, and a pick hook (below).
- Host, model, panel key and chip view wired to them. `Tests/ExtensionNestTests.swift`
  (suite "extension nesting", 7 tests) with a fake `ChatProbe`; NotesProbe and sight unchanged.

## Changed contracts (for capsule-pro)

All additions to `Sources/Kit/Extension.swift`, each with a default, so an extension written
against c6b2d45 compiles and behaves the same:

- `MentionTarget` gains `nests: Bool` (default false) and `parentID: String?` (default nil), as
  trailing init parameters with defaults. `nests == true` means picking it makes a chip under
  which a second `@` asks the same extension for children.
- `public struct MentionContext: Sendable, Equatable { parent: MentionTarget?; extensionID: String? }`
  with `MentionContext.top` for "no chip". `parent` is the current chip when it belongs to the
  extension being asked; `extensionID` is that chip's extension.
- `mentions(matching:context:) -> [MentionTarget]`: the Capsule calls this one. Default:
  `context.parent == nil ? mentions(matching:) : []`.
- `refreshMentions(matching:context:) async -> [MentionTarget]?`: default nil. The model calls it
  once, 120 ms after the last keystroke, only while shown; the next keystroke and hide cancel it;
  a non-nil answer replaces that extension's rows if the words are unchanged. No polling.
- `mentionPicked(_:context:)`: default no-op, called once when a target becomes the chip (an app
  chip can prefetch its contacts into memory).
- `send(_:to:in:query:) async -> ActionOutcome`: the Capsule calls this one, with the chip the
  child was picked under (or nil). Default forwards to `send(_:to:query:)`.

Capsule side (internal, capsule-pro's files):

- `CapsuleModel`: `targetParent` (the outer chip of a two-level chip), `nestingChip`,
  `dropChip()` (delete on an empty box: child first, then the chip), `listMentions`,
  `refreshMentions(_:token:)`, `mentionIcon(_:)`. `extensionMentions` now takes the nesting chip;
  new closures `extensionRefresh` and `extensionPicked`; `sendToExtension` also takes the parent.
  With a nesting chip, Vyre's agents, projects and sessions are not listed and projects.catalog is
  not asked.
- `ExtensionHost`: `ExtensionMention` (ext id, candidate, target); `mentions(_:parent:)`,
  `refreshMentions(_:parent:)`, `picked(_:parent:)`. A child's candidate id is
  `<chip id>><child id>`, so the same contact under two apps stays two targets.
- `Panel`: delete on an empty box calls `model.dropChip()`.
- `CapsuleView`: the chip draws the extension's icon (an app's own) and "WhatsApp › juno".

## Doing

Nothing.

## Next

- capsule-apps (the extension itself) builds WhatsApp and friends on this seam.
- Snapshot of the two-level chip in SnapshotTests once capsule-pro has merged the view change.

## Needs from others

- capsule-pro: review and merge the Kit additions and the Host/model/view edits.
