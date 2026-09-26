// Emoji tests: triggers, search order, and what building the table costs.

import Foundation

private func heapInUse() -> Int {
    var s = malloc_statistics_t()
    malloc_zone_statistics(nil, &s)
    return Int(s.size_in_use)
}

// capsule-suite: emojiSuite
let emojiSuite = Suite("emoji") { t in
    t.test("the table builds lazily, is small, and can be released") {
        EmojiIndex.release()
        t.ok(!EmojiIndex.isBuilt)
        let before = heapInUse()
        let start = DispatchTime.now().uptimeNanoseconds
        let n = EmojiIndex.shared.entries.count
        let ms = Double(DispatchTime.now().uptimeNanoseconds - start) / 1e6
        let kb = Double(heapInUse() - before) / 1024
        print("emoji: \(n) entries built in \(String(format: "%.1f", ms)) ms (unoptimized test build), heap +\(String(format: "%.0f", kb)) KB")
        t.ok(n > 1000 && n < 3000, "\(n) entries")
        t.ok(kb < 1024, "under a megabyte: \(kb) KB")
        t.ok(EmojiIndex.isBuilt)
        EmojiIndex.release()
        t.ok(!EmojiIndex.isBuilt)
    }

    t.test("only asked-for queries search") {
        t.eq(Emoji.term("emoji heart"), "heart")
        t.eq(Emoji.term("smile emoji"), "smile")
        t.eq(Emoji.term(":thumbs"), "thumbs")
        t.eq(Emoji.term(":thumbs_up:"), "thumbs_up")
        for q in ["heart", "emoji", ":", ":a", ": heart", "emojis", "emoji   ", "my emoji notes are here and there"] {
            t.ok(Emoji.term(q) == nil || Emoji.search(q).isEmpty, q)
        }
        t.ok(Emoji.search("heart").isEmpty, "a bare word is not an emoji search")
    }

    t.test("search finds by name and alias") {
        let thumbs = Emoji.search(":thumbs")
        t.ok(thumbs.contains { $0.emoji == "👍" }, "\(thumbs.map(\.emoji))")
        t.eq(Emoji.search(":thumbs_up").first?.emoji, "👍")
        t.ok(Emoji.search("emoji heart").contains { $0.emoji == "❤️" }, "text-default heart gets FE0F")
        t.ok(Emoji.search("smile emoji").count > 1)
        t.eq(Emoji.search("emoji lol").first?.emoji, "😂")
        t.eq(Emoji.search("emoji party").first?.emoji, "🎉")
        t.eq(Emoji.search("emoji grinning face").first?.emoji, "😀", "the whole name wins")
        t.ok(Emoji.search("emoji qqqqzz").isEmpty)
        t.ok(!Emoji.search("emoji skin").contains { $0.scalar >= 0x1F3FB && $0.scalar <= 0x1F3FF }, "modifiers are not emoji to pick")
        t.ok(Emoji.search("emoji skin").count <= 8)
    }

    t.test("emojiResults rows") {
        let rows = emojiResults(Query(":thumbs"))
        t.ok(!rows.isEmpty)
        let up = rows.first { $0.copyText == "👍" }
        t.eq(up?.title, "Thumbs up sign")
        t.eq(up?.icon, .glyph("👍"))
        t.eq(up?.id, "emoji:1f44d")
        t.eq(up?.kind, "emoji")
        t.ok(emojiResults(Query("thumbs")).isEmpty)
    }

    t.test("searching is fast once built") {
        _ = EmojiIndex.shared
        let n = 200, start = DispatchTime.now().uptimeNanoseconds
        for _ in 0..<n { _ = Emoji.search(":thu"); _ = Emoji.search("emoji red heart") }
        let per = Double(DispatchTime.now().uptimeNanoseconds - start) / 1e6 / Double(2 * n)
        print("emoji: \(String(format: "%.3f", per)) ms per search (unoptimized test build)")
        t.ok(per < 5)
        EmojiIndex.release()
    }
}
