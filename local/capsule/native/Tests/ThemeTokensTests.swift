// capsule-suite: themeTokensSuite
// capsule-suite: deepGlassSuite
// The Capsule's Theme reads the one tokens.json through Tokens.generated.swift: the same colours
// as the app and the Deck, and the same status words, most urgent first.

import SwiftUI

let themeTokensSuite = Suite("theme tokens") { t in
    t.test("Theme's colours are the dark scheme's tokens; attention is beacon") {
        t.ok(Theme.graphite == Tokens.dark.bg)
        t.ok(Theme.bone == Tokens.dark.text)
        t.ok(Theme.signal == Tokens.dark.focus)
        t.ok(Theme.attention == Tokens.dark.beacon)
        t.eq(Theme.radius, Tokens.Radius.sheet, "the panel is a sheet (capsule.md, The panel)")
    }

    t.test("the status model: order, words, and colours by key") {
        t.eq(Tokens.status.map(\.key), ["needsYou", "failed", "running", "unread", "done"])
        t.eq(Theme.status("needsYou")?.word, "needs you")
        t.ok(Theme.status("needsYou")?.color == Tokens.dark.beacon)
        t.ok(Theme.status("running")?.color == Tokens.dark.focus)
        t.ok(Theme.status("nope") == nil)
    }
}

let deepGlassSuite = Suite("glass skin") { t in
    t.test("Deep glass: a 0.62 tint over the material, opaque when transparency is reduced") {
        DeepGlass.reduceTransparencyOverride = false
        t.eq(DeepGlass.groundAlpha, 0.62)
        t.ok(DeepGlass.border == Theme.bone.opacity(0.14))
        DeepGlass.reduceTransparencyOverride = true
        t.eq(DeepGlass.groundAlpha, 1.0)
        t.ok(DeepGlass.border == Theme.ruleStrong.opacity(0.9))
        DeepGlass.reduceTransparencyOverride = nil
    }

    t.test("the skin keeps the panel's width and the CTA colour from the token") {
        t.eq(Theme.width, 680)
        t.ok(Theme.signal == Tokens.dark.focus)
    }
}
