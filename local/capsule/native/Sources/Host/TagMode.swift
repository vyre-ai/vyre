// TagMode: "#" in the box (Core/TagPicker.swift). Typing "#" and some letters lists what can be tagged,
// from platform's `mentions.search` (names only, grouped by kind in the order given); Tab or Return
// writes the pick as #Name and keeps it as a chip the send carries ({kind, id, name}). Nothing is asked
// until a "#" is typed, the search waits for the words to settle, and a newer one cancels an older.

import AppKit
import Foundation

extension CapsuleModel {
    /// The "#" being typed at the end of the box, when there is one and a place to search.
    var hashToken: (start: String.Index, partial: String)? {
        guard mentionQuery == nil, bindingEdit == nil, viewSession == nil, vyred.has("mentions.search") else { return nil }
        return TagToken.trailing(in: text)
    }

    /// Show the list for a "#" token. Returns true when the box is in tag mode.
    func searchTags(_ token: (start: String.Index, partial: String), token t: Int) {
        recallTask?.cancel(); memory = nil; autoTask?.cancel()
        tagTask?.cancel()
        let q = token.partial
        tagTask = Task { @MainActor [vyred] in
            try? await Task.sleep(nanoseconds: 120_000_000)
            if Task.isCancelled || t != self.token { return }
            let r = await vyred.call("mentions.search", ["q": q, "limit": 12], presence: false)
            if Task.isCancelled || t != self.token { return }
            if let why = r.error { self.groups = []; self.line = why; return }
            let hits = TagResults.parse(r.data)
            self.tagHits = hits
            self.groups = hits.isEmpty ? [] : [Group(section: .other, items: hits.map(self.tagRow))]
            self.selected = 0
            if hits.isEmpty { self.line = q.isEmpty ? "Nothing to tag yet." : "Nothing called that to tag." }
        }
    }

    func tagRow(_ h: TagHit) -> ResultItem {
        ResultItem(id: "tag:\(h.kind):\(h.id)", kind: "tag", title: h.name, subtitle: h.label, icon: .symbol(TagResults.symbol(kind: h.kind, icon: h.icon)),
                   section: .other, score: 1,
                   actions: [ResultAction(id: "tag", title: "Add #\(h.name)", symbol: "number") { [weak self] _, _ in
                       await MainActor.run { self?.pickTag(h); return .said("") }
                   }])
    }

    /// Write the tag into the words and keep it as a chip.
    func pickTag(_ h: TagHit) {
        guard let tok = TagToken.trailing(in: text) else { return }
        if !pickedTags.contains(where: { $0.kind == h.kind && $0.id == h.id }) { pickedTags.append(h) }
        tagHits = []
        text = TagToken.insert(h.name, into: text, replacing: tok.start)
        line = nil
    }

    /// The chips still written in `words`, as the send carries them (threads.send's `mentions`).
    func tagsFor(_ words: String) -> [[String: String]] {
        TagToken.stillIn(words, pickedTags).map { ["kind": $0.kind, "id": $0.id, "name": $0.name] }
    }

    /// Take a chip off: its token leaves the words.
    func removeTag(_ h: TagHit) {
        pickedTags.removeAll { $0.kind == h.kind && $0.id == h.id }
        text = text.replacingOccurrences(of: TagToken.token(h.name) + " ", with: "").replacingOccurrences(of: TagToken.token(h.name), with: "")
    }

    /// Chips whose token is no longer in the words are dropped.
    func syncTags() {
        guard !pickedTags.isEmpty else { return }
        let keep = TagToken.stillIn(text, pickedTags)
        if keep != pickedTags { pickedTags = keep }
    }
}
