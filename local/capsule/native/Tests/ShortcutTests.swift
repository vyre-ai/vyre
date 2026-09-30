// capsule-suite: shortcutSuite
// The standard macOS shortcuts in the Capsule. The user found ⌘A did nothing: the app had no main
// menu, so AppKit had nowhere to find the key equivalents. These check that every standard one is
// in the menu with its action, that the panel routes ⌘A to the box's field editor (select all, then
// undo of typing), and that the Capsule's own key handler lets the text and window keys through
// while keeping its own (↑↓ in results, Esc, ⏎). Events are made here and handed to our own panel
// and handler only; nothing is posted to the system.

import AppKit

@MainActor private func keyEvent(_ chars: String, _ code: UInt16, _ mods: NSEvent.ModifierFlags = [], window: Int = 0) -> NSEvent {
    let shown = mods.contains(.shift) ? chars.uppercased() : chars
    return NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: mods, timestamp: 0, windowNumber: window, context: nil,
                            characters: shown, charactersIgnoringModifiers: shown, isARepeat: false, keyCode: code)!
}

@MainActor private func findField(_ v: NSView) -> NSTextField? {
    if let f = v as? NSTextField, f.isEditable { return f }
    for s in v.subviews { if let f = findField(s) { return f } }
    return nil
}

let shortcutSuite = Suite("shortcuts") { t in
    t.test("the main menu carries every standard shortcut with its action") {
        let rows: [(String, UInt16, NSEvent.ModifierFlags, String)] = [
            ("a", 0, [.command], "selectAll:"), ("z", 6, [.command], "undo:"), ("z", 6, [.command, .shift], "redo:"),
            ("x", 7, [.command], "cut:"), ("c", 8, [.command], "copy:"), ("v", 9, [.command], "paste:"),
            ("v", 9, [.command, .option, .shift], "pasteAsPlainText:"), ("f", 3, [.command], "findInBox:"),
            (" ", 49, [.command, .control], "orderFrontCharacterPalette:"), ("w", 13, [.command], "closeCapsule:"),
            (",", 43, [.command], "openSettings:"), ("q", 12, [.command], "closeCapsule:"),
        ]
        let got = MainActor.assumeIsolated { () -> [String] in
            let menu = MainMenu.make(MenuActions())
            return rows.map { r in MainMenu.item(for: keyEvent(r.0, r.1, r.2), in: menu)?.action.map(NSStringFromSelector) ?? "none" }
        }
        t.eq(got, rows.map(\.3))
        let delete = MainActor.assumeIsolated { MainMenu.make(MenuActions()).items.compactMap(\.submenu).flatMap(\.items).first { $0.title == "Delete" }?.action }
        t.eq(delete.map(NSStringFromSelector), "delete:")
        // A plain letter is typing, never a menu item.
        t.ok(MainActor.assumeIsolated { MainMenu.item(for: keyEvent("a", 0), in: MainMenu.make(MenuActions())) == nil })
    }

    t.test("⌘A in the box selects all, ⌘Z undoes typing, through the panel") {
        let r = MainActor.assumeIsolated { () -> (Int, Int, String) in
            let saved = NSApplication.shared.mainMenu
            NSApplication.shared.mainMenu = MainMenu.make(MenuActions())
            defer { NSApplication.shared.mainMenu = saved }
            let model = CapsuleModel(home: vyScratch("keys-home"), vyred: VyredClient(socket: vyScratch("keys") + "/none.sock"), providers: [])
            let pc = PanelController(model: model)
            pc.showOffscreen()
            defer { pc.hide(); pc.panel.orderOut(nil) }
            RunLoop.main.run(until: Date().addingTimeInterval(0.1))
            guard let field = findField(pc.host) else { return (-1, -1, "no field") }
            pc.panel.makeFirstResponder(field)
            guard let editor = pc.panel.firstResponder as? NSTextView else { return (-2, -2, "no editor") }
            editor.insertText("northwind menu", replacementRange: editor.selectedRange())
            let n = (editor.string as NSString).length
            _ = pc.panel.performKeyEquivalent(with: keyEvent("a", 0, [.command], window: pc.panel.windowNumber))
            let selected = editor.selectedRange().length
            _ = pc.panel.performKeyEquivalent(with: keyEvent("z", 6, [.command], window: pc.panel.windowNumber))
            return (n, selected, editor.string)
        }
        t.eq(r.0, 14)
        t.eq(r.1, 14, "⌘A selected the whole box")
        t.ok(r.2 != "northwind menu", "⌘Z undid the typing, box now \"\(r.2)\"")
    }

    t.test("the Capsule's key handler lets text and window keys through and keeps its own") {
        let r = MainActor.assumeIsolated { () -> [String] in
            let model = CapsuleModel(home: vyScratch("keys-home2"), vyred: VyredClient(socket: vyScratch("keys") + "/none.sock"), providers: [])
            let pc = PanelController(model: model)
            model.text = "harlow intake"
            let through: [(String, String, UInt16, NSEvent.ModifierFlags)] = [
                ("⌘A", "a", 0, [.command]), ("⌘X", "x", 7, [.command]), ("⌘V", "v", 9, [.command]),
                ("⌘Z", "z", 6, [.command]), ("⇧⌘Z", "z", 6, [.command, .shift]), ("⌥⇧⌘V", "v", 9, [.command, .option, .shift]),
                ("⌘←", "\u{F702}", 123, [.command]), ("⇧⌘←", "\u{F702}", 123, [.command, .shift]), ("⇧⌘→", "\u{F703}", 124, [.command, .shift]),
                ("⌥←", "\u{F702}", 123, [.option]), ("⌥→", "\u{F703}", 124, [.option]), ("⇧⌥←", "\u{F702}", 123, [.option, .shift]),
                ("⌘↑", "\u{F700}", 126, [.command]), ("⌘↓", "\u{F701}", 125, [.command]), ("⇧↑", "\u{F700}", 126, [.shift]), ("⇧↓", "\u{F701}", 125, [.shift]),
                ("⌥⌫", "\u{7f}", 51, [.option]), ("⌘⌫", "\u{7f}", 51, [.command]),
                ("⌃A", "a", 0, [.control]), ("⌃E", "e", 14, [.control]), ("⌃K", "k", 40, [.control]),
                ("⌃⌘Space", " ", 49, [.command, .control]), ("⌘W", "w", 13, [.command]), ("⌘,", ",", 43, [.command]),
                ("⌘Q", "q", 12, [.command]), ("⌘F", "f", 3, [.command]),
            ]
            var out: [String] = []
            for k in through where pc.key(keyEvent(k.1, k.2, k.3)) { out.append("took \(k.0)") }
            // Its own: ↓ and ↑ move in the results, Esc empties the box, ⏎ runs the row.
            if !pc.key(keyEvent("\u{F701}", 125)) { out.append("left ↓") }
            if !pc.key(keyEvent("\u{F700}", 126)) { out.append("left ↑") }
            if !pc.key(keyEvent("\u{1b}", 53)) { out.append("left Esc") }
            if model.text != "" { out.append("Esc kept the words") }
            return out
        }
        t.eq(r, [])
    }
}
