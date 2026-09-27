// capsule-suite: themeTokensSuite
// The Capsule's Theme reads the one tokens.json through Tokens.generated.swift: the same colours
// as the app and the Deck, and the same status words, most urgent first.

import SwiftUI

let themeTokensSuite = Suite("theme tokens") { t in
    t.test("Theme's colours are the dark scheme's tokens; attention is beacon") {
        t.ok(Theme.graphite == Tokens.dark.bg)
        t.ok(Theme.bone == Tokens.dark.text)
        t.ok(Theme.signal == Tokens.dark.focus)
        t.ok(Theme.attention == Tokens.dark.beacon)
        t.eq(Theme.radius, Tokens.Radius.card)
    }

    t.test("the status model: order, words, and colours by key") {
        t.eq(Tokens.status.map(\.key), ["needsYou", "failed", "running", "unread", "done"])
        t.eq(Theme.status("needsYou")?.word, "needs you")
        t.ok(Theme.status("needsYou")?.color == Tokens.dark.beacon)
        t.ok(Theme.status("running")?.color == Tokens.dark.focus)
        t.ok(Theme.status("nope") == nil)
    }
}
