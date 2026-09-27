// capsule-suite: answerScrollSuite
// The answer card grows with its words, then scrolls (UI/AnswerScroll.swift): drawn off screen,
// no window on the user's screen. VYRE_CAPSULE_SNAP writes the pictures, as SnapshotTests does.

import AppKit
import SwiftUI

@MainActor private func longAnswerModel(rows: [ResultItem], paragraphs: Int) -> CapsuleModel {
    let m = snapModel(rows)
    if !rows.isEmpty { m.text = "sa" }
    m.asked = "plan the Northwind Bakery spring menu launch"
    var r = VyState.reply("long1"); r.model = "haiku"; r.finished = true; r.ok = true
    r.order = ["m"]
    r.text = ["m": (1...paragraphs).map { i in
        "Step \(i). Price the new croissant range against last spring, check the flour order with the supplier, and tell alex what changed so the counter staff can answer questions."
    }.joined(separator: "\n\n")]
    m.reply = r
    return m
}

@MainActor private var offscreen: [NSWindow] = []

@MainActor private func draw(_ m: CapsuleModel) -> NSHostingView<CapsuleView> {
    let host = NSHostingView(rootView: CapsuleView(model: m, focus: FocusTicket(), snapshot: true))
    host.frame = NSRect(x: 0, y: 0, width: Theme.width, height: CapsuleLayout.panelHeight(m))
    host.appearance = NSAppearance(named: .darkAqua)
    // In a window that is never ordered in, so AppKit sizes the scroll view's document as it
    // would on screen. Nothing appears and nothing takes focus; closed at the end of the suite.
    let w = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: true)
    w.isReleasedWhenClosed = false
    w.contentView = host
    offscreen.append(w)
    for _ in 0..<4 {
        host.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.03))
    }
    return host
}

@MainActor private func png(_ host: NSView, _ name: String) {
    guard let dir = ProcessInfo.processInfo.environment["VYRE_CAPSULE_SNAP"],
          let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return }
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    host.cacheDisplay(in: host.bounds, to: rep)
    if let data = rep.representation(using: .png, properties: [:]) { try? data.write(to: URL(fileURLWithPath: dir).appendingPathComponent(name + ".png")) }
}

let answerScrollSuite = Suite("answer scroll") { t in
    t.test("the card is as tall as a short answer, up to its cap") {
        t.eq(CapsuleLayout.answerHeight(content: 120.2, cap: 300), 121)
        t.eq(CapsuleLayout.answerHeight(content: 900, cap: 300), 300)
        t.eq(CapsuleLayout.answerHeight(content: 0, cap: 300), 80, "a small card before the first measure")
        let caps = MainActor.assumeIsolated { () -> (CGFloat, CGFloat, CGFloat) in
            let alone = longAnswerModel(rows: [], paragraphs: 1)
            let over = longAnswerModel(rows: snapRows(), paragraphs: 1)
            return (CapsuleLayout.answerCap(alone, alone: true), CapsuleLayout.answerCap(over, alone: false), CapsuleLayout.area - CapsuleLayout.footerHeight)
        }
        t.eq(caps.0, caps.2, "alone, the whole area above the footer")
        t.ok(caps.1 < caps.0 && caps.1 >= caps.0 - 1 - 6 - Theme.headerHeight - 2 * Theme.rowHeight - 0.5, "above results, room for a heading and two rows")
    }

    t.test("a long answer alone scrolls instead of clipping, and keys page through it") {
        let r = MainActor.assumeIsolated { () -> [String] in
            let m = longAnswerModel(rows: [], paragraphs: 14)
            // The panel first: the card drawn last is the one the scroller holds.
            let pc = PanelController(model: m)
            let host = draw(m)
            m.answerScroll.toEnd()
            for _ in 0..<2 { host.layoutSubtreeIfNeeded(); RunLoop.main.run(until: Date().addingTimeInterval(0.03)) }
            png(host, "7-long-answer")
            var out: [String] = []
            let s = m.answerScroll
            guard let sv = s.scrollView, let doc = sv.documentView else { return ["no scroll view found for the answer"] }
            if !s.overflows { out.append("did not overflow: doc \(doc.frame.height) in \(sv.contentView.bounds.height)") }
            if abs(sv.frame.height - CapsuleLayout.answerCap(m, alone: true)) > 1 { out.append("card \(sv.frame.height) is not the cap") }
            // Finished answers follow to the end; the keys go up and back.
            if !s.atEnd { out.append("not following to the end") }
            let end = s.offset
            _ = pc.key(key("\u{F72C}", 116)) // PageUp
            if !(s.offset < end) { out.append("PageUp did not scroll up") }
            if s.following { out.append("still following after the user scrolled up") }
            _ = pc.key(key("\u{F700}", 126, [.command]))
            if s.offset != 0 { out.append("⌘↑ is not the top: \(s.offset)") }
            for _ in 0..<2 { host.layoutSubtreeIfNeeded(); RunLoop.main.run(until: Date().addingTimeInterval(0.03)) }
            png(host, "7b-long-answer-top")
            _ = pc.key(key("\u{F72D}", 121)) // PageDown
            if !(s.offset > 0) { out.append("PageDown did not scroll down") }
            _ = pc.key(key("\u{F701}", 125, [.command]))
            if !s.atEnd || !s.following { out.append("⌘↓ did not reach the end and follow again") }
            // The thumb is there while it can scroll, at the bottom when following.
            if let th = s.thumb { if abs(th.start + th.length - 1) > 0.01 { out.append("thumb not at the end: \(th)") } } else { out.append("no thumb") }
            // ⌥↑ ⌥↓: three lines at a time.
            let at = s.offset
            _ = pc.key(key("\u{F700}", 126, [.option]))
            if abs((at - s.offset) - 3 * Theme.readLine) > 0.5 { out.append("⌥↑ moved \(at - s.offset)") }
            if s.following { out.append("⌥↑ kept following, so no Jump to latest") }
            _ = pc.key(key("\u{F701}", 125, [.option]))
            if abs(s.offset - at) > 0.5 { out.append("⌥↓ did not come back") }
            return out
        }
        t.eq(r, [])
    }

    t.test("a stream follows its newest words unless the user scrolled up") {
        let r = MainActor.assumeIsolated { () -> [String] in
            let m = longAnswerModel(rows: [], paragraphs: 10)
            let host = draw(m)
            let s = m.answerScroll
            var out: [String] = []
            guard s.overflows else { return ["did not overflow: doc \(s.scrollView?.documentView?.frame.height ?? -1) clip \(s.scrollView?.contentView.bounds.height ?? -1)"] }
            // More words land while following: the end stays in sight.
            var more = m.reply!; more.text["m"]! += "\n\nStep 11. Put the menu on the site."
            m.reply = more
            _ = draw(m); host.layoutSubtreeIfNeeded()
            if !s.atEnd { out.append("lost the end while following") }
            // The user scrolls up: new words no longer pull the card down.
            s.page(-1)
            let held = s.offset
            more.text["m"]! += "\n\nStep 12. Tell juno it is done."
            m.reply = more
            for _ in 0..<3 { host.layoutSubtreeIfNeeded(); RunLoop.main.run(until: Date().addingTimeInterval(0.03)) }
            if s.offset != held { out.append("moved from \(held) to \(s.offset) while the user read above") }
            return out
        }
        t.eq(r, [])
    }

    t.test("above results the card grows then scrolls, and the results keep their rows") {
        let r = MainActor.assumeIsolated { () -> [String] in
            let m = longAnswerModel(rows: snapRows(), paragraphs: 14)
            let host = draw(m)
            png(host, "8-long-answer-results")
            var out: [String] = []
            guard let sv = m.answerScroll.scrollView else { return ["no scroll view found for the answer"] }
            if !m.answerScroll.overflows { out.append("did not overflow: doc \(sv.documentView?.frame.height ?? -1) clip \(sv.contentView.bounds.height) frame \(sv.frame.height)") }
            if abs(sv.frame.height - CapsuleLayout.answerCap(m, alone: false)) > 1 { out.append("card \(sv.frame.height) is not the cap \(CapsuleLayout.answerCap(m, alone: false))") }
            // A short answer is only as tall as its words.
            let short = longAnswerModel(rows: snapRows(), paragraphs: 1)
            _ = draw(short)
            if let s2 = short.answerScroll.scrollView, s2.frame.height >= CapsuleLayout.answerCap(short, alone: false) - 1 { out.append("a short answer took the whole cap") }
            if short.answerScroll.overflows { out.append("a short answer overflowed") }
            return out
        }
        t.eq(r, [])
    }

    t.test("the results list ends on a whole row, never on a bare heading") {
        let r = MainActor.assumeIsolated { () -> [CGFloat] in
            let rows = snapRows()
            let top = CapsuleModel.Group(section: .top, items: [rows[0]])
            let apps = CapsuleModel.Group(section: .apps, items: Array(rows[1...3]))
            let h = Theme.headerHeight, row = Theme.rowHeight, big = Theme.rowHeight + 12
            return [
                // Room for the top hit and the next heading but not its first row: stop after the top hit.
                CapsuleLayout.fit([top, apps], in: h + big + h + row - 1),
                // Room for one apps row and half of the next: one row.
                CapsuleLayout.fit([top, apps], in: h + big + h + row + row / 2),
                // Room for all: all, and the bottom padding.
                CapsuleLayout.fit([top, apps], in: 1000),
                // Not even the first heading and row: nothing.
                CapsuleLayout.fit([apps], in: h + row - 1),
            ]
        }
        let h = Theme.headerHeight, row = Theme.rowHeight, big = Theme.rowHeight + 12
        t.eq(r, [h + big + 6, h + big + h + row + 6, h + big + h + 3 * row + 6, 0])
    }

    t.test("no group without rows, so no bare Send to or Commands heading") {
        let r = MainActor.assumeIsolated { () -> [String] in
            let m = snapModel([])
            m.groups = [CapsuleModel.Group(section: .commands, items: []), CapsuleModel.Group(section: .vyre, items: [])]
            var out: [String] = []
            if !m.groups.isEmpty { out.append("kept \(m.groups.count) empty groups") }
            // No assistant on this vyred: the destinations are none, and nothing is published for them.
            m.text = "what is the weather in the harlow office"
            if m.groups.contains(where: { $0.items.isEmpty }) { out.append("an empty group after typing") }
            return out
        }
        t.eq(r, [])
        MainActor.assumeIsolated { offscreen.forEach { $0.close() }; offscreen = [] }
    }
}

@MainActor private func key(_ chars: String, _ code: UInt16, _ mods: NSEvent.ModifierFlags = []) -> NSEvent {
    NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: mods, timestamp: 0, windowNumber: 0, context: nil,
                     characters: chars, charactersIgnoringModifiers: chars, isARepeat: false, keyCode: code)!
}
