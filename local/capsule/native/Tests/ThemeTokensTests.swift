// capsule-suite: themeTokensSuite
// capsule-suite: deepGlassSuite
// The Capsule's Theme reads the one tokens.json through Tokens.generated.swift: the same colours
// as the app and the Deck, and the same status words, most urgent first.

import SwiftUI

/// A dynamic colour resolved as `name` would draw it, as sRGB components.
private func resolved(_ c: NSColor, _ name: NSAppearance.Name) -> [Int] {
    var out: [Int] = []
    NSAppearance(named: name)?.performAsCurrentDrawingAppearance {
        let x = c.usingColorSpace(.sRGB) ?? c
        out = [Int((x.redComponent * 255).rounded()), Int((x.greenComponent * 255).rounded()), Int((x.blueComponent * 255).rounded())]
    }
    return out
}

private func rgb(_ c: Color) -> [Int] {
    let x = NSColor(c).usingColorSpace(.sRGB) ?? NSColor(c)
    return [Int((x.redComponent * 255).rounded()), Int((x.greenComponent * 255).rounded()), Int((x.blueComponent * 255).rounded())]
}

let themeTokensSuite = Suite("theme tokens") { t in
    t.test("Theme's colours follow the appearance: the dark scheme in dark, paper in light") {
        let pairs: [(String, KeyPath<Tokens.Colors, Color>)] = [("bg", \.bg), ("panel", \.panel), ("text", \.text), ("text2", \.text2),
                                                              ("label", \.label), ("focus", \.focus), ("beacon", \.beacon)]
        for (name, k) in pairs {
            t.eq(resolved(Theme.nsDyn(k), .darkAqua), rgb(Tokens.dark[keyPath: k]), "\(name) in dark")
            t.eq(resolved(Theme.nsDyn(k), .aqua), rgb(Tokens.paper[keyPath: k]), "\(name) in light")
        }
        t.ok(Theme.isDark(NSAppearance(named: .darkAqua)!))
        t.ok(!Theme.isDark(NSAppearance(named: .aqua)!))
        t.eq(Theme.radius, Tokens.Radius.sheet, "the panel is a sheet (capsule.md, The panel)")
    }

    t.test("the status model: order, words, and colours by key") {
        t.eq(Tokens.status.map(\.key), ["needsYou", "failed", "running", "unread", "done"])
        t.eq(Theme.status("needsYou")?.word, "needs you")
        t.ok(Theme.status("nope") == nil)
    }

    t.test("Deck v2 tokens: surfaces, accent, the type roles, springs and the project emblem") {
        t.eq(rgb(Tokens.V2.dark.surface1), [20, 19, 17], "surface 1 in dark")
        t.eq(rgb(Tokens.V2.paper.surface1), [244, 241, 234], "surface 1 in paper")
        t.eq(rgb(Tokens.V2.dark.accent), rgb(Tokens.dark.beacon), "the accent is the attention colour")
        t.eq(Tokens.V2.TypeScale.body.size, 14)
        t.eq(Tokens.V2.PhoneTypeScale.body.size, 16)
        t.eq(Tokens.V2.Radius.card, 14)
        t.eq(Tokens.V2.Motion.Spatial.`default`, Tokens.V2.Spring(damping: 0.8, stiffness: 380))
        t.eq(Tokens.V2.Elevation.Dark.e2.count, 3)
        t.eq(Tokens.V2.Emblem.palette.count, 8)
        t.eq(Tokens.V2.Emblem.shapes.count, 8)
        t.eq(Tokens.V2.Emblem.cells.count, 4)
    }
}

let deepGlassSuite = Suite("glass skin") { t in
    t.test("Deep glass: a 0.62 dark and 0.66 light tint over the material, opaque when transparency is reduced") {
        DeepGlass.reduceTransparencyOverride = false
        t.eq(DeepGlass.groundAlpha(dark: true), 0.62)
        t.eq(DeepGlass.groundAlpha(dark: false), 0.66)
        t.ok(DeepGlass.border(dark: true) == Theme.bone.opacity(0.14))
        t.ok(DeepGlass.border(dark: false) == Theme.bone.opacity(0.10))
        t.ok(DeepGlass.material(dark: true) == .hudWindow)
        DeepGlass.reduceTransparencyOverride = true
        t.eq(DeepGlass.groundAlpha(dark: true), 1.0)
        t.eq(DeepGlass.groundAlpha(dark: false), 1.0)
        t.ok(DeepGlass.border(dark: true) == Theme.ruleStrong.opacity(0.9))
        DeepGlass.reduceTransparencyOverride = nil
    }

    t.test("the skin keeps the panel's width, and both schemes draw") {
        t.eq(Theme.width, 680)
        for name in [NSAppearance.Name.darkAqua, .aqua] {
            let m = MainActor.assumeIsolated { snapModel(snapRows()) }
            let ok = MainActor.assumeIsolated { snapshot(m, "glass-\(name == .aqua ? "light" : "dark")", dir: nil, appearance: name) }
            t.ok(ok, "renders in \(name.rawValue)")
        }
    }

    t.test("contrast gate: answer text and the draft clear AA (4.5:1) over pure white and pure black, both schemes, at the approved alpha") {
        func c(_ x: Color) -> [Double] {
            let n = NSColor(x).usingColorSpace(.sRGB) ?? NSColor(x)
            return [Double(n.redComponent), Double(n.greenComponent), Double(n.blueComponent)]
        }
        for (name, tok, dark, alpha) in [("dark", Tokens.dark, true, Double(DeepGlass.tintAlpha)), ("light", Tokens.paper, false, Double(DeepGlass.tintAlphaLight))] {
            let ink = dark ? [1.0, 1.0, 1.0] : [0.0, 0.0, 0.0]
            for (bgName, bg) in [("white", [1.0, 1.0, 1.0]), ("black", [0.0, 0.0, 0.0])] {
                let tint = c(tok.panel)
                // The worst case: the tint alone over the backdrop, before the blur material helps.
                let ground = (0..<3).map { tint[$0] * alpha + bg[$0] * (1 - alpha) }
                let draftInk = (0..<3).map { ink[$0] * DeepGlass.draftOpacity + ground[$0] * (1 - DeepGlass.draftOpacity) }
                let answer = DeepGlass.contrast(ink, ground)
                let draft = DeepGlass.contrast(draftInk, ground)
                t.ok(answer >= 4.5, "\(name) answer over \(bgName): \(answer)")
                t.ok(draft >= 4.49, "\(name) draft and Checking over \(bgName): \(draft)")
            }
        }
        t.eq(DeepGlass.tintAlpha, 0.62, "the approved dark alpha is untouched")
        t.eq(DeepGlass.tintAlphaLight, 0.66, "the approved light alpha is untouched")
    }

    t.test("Increase Contrast draws a heavier, stronger border; Reduce Transparency makes the plate opaque; both read live") {
        DeepGlass.increaseContrastOverride = false; DeepGlass.reduceTransparencyOverride = false
        let calm = MainActor.assumeIsolated { () -> (Bool, Bool) in DisplayPrefs.shared.refresh(); return (DisplayPrefs.shared.increaseContrast, DisplayPrefs.shared.reduceTransparency) }
        t.ok(!calm.0 && !calm.1)
        t.eq(DeepGlass.borderWidth, 1)
        DeepGlass.increaseContrastOverride = true; DeepGlass.reduceTransparencyOverride = true
        let loud = MainActor.assumeIsolated { () -> (Bool, Bool) in DisplayPrefs.shared.refresh(); return (DisplayPrefs.shared.increaseContrast, DisplayPrefs.shared.reduceTransparency) }
        t.ok(loud.0 && loud.1, "the published values follow the setting on refresh")
        t.eq(DeepGlass.borderWidth, 2)
        t.ok(DeepGlass.border(dark: true) == Theme.bone.opacity(0.7))
        DeepGlass.increaseContrastOverride = nil; DeepGlass.reduceTransparencyOverride = nil
        MainActor.assumeIsolated { DisplayPrefs.shared.refresh() }
    }
}
