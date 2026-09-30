// MainMenu: the menu the standard shortcuts need. An accessory app with a non-activating panel has
// no menu bar of its own, and without NSApp.mainMenu AppKit has nowhere to find ⌘A, ⌘Z, ⌘V and the
// rest, so they did nothing in the box. This is the standard app and Edit menu (plus Window's
// Close), installed at launch and never shown. CapsulePanel.performKeyEquivalent routes to it
// directly, since the Capsule's app is never the active one.
//
//   ⌘Z Undo · ⇧⌘Z Redo · ⌘X Cut · ⌘C Copy · ⌘V Paste · ⌥⇧⌘V Paste and Match Style · Delete
//   ⌘A Select All · ⌘F Find (the box) · ⌃⌘Space Emoji & Symbols · Start Dictation (AppKit)
//   ⌘W Close (hides) · ⌘, Settings (the menu-bar popover) · ⌘Q hides; quitting is in the menu bar
//   item's menu, since a hidden Capsule quitting on a stray ⌘Q loses its hot keys.

import AppKit

@MainActor final class MenuActions: NSObject {
    var hide: () -> Void = {}
    var settings: () -> Void = {}
    var find: () -> Void = {}
    @objc func closeCapsule(_ sender: Any?) { hide() }
    @objc func openSettings(_ sender: Any?) { settings() }
    @objc func findInBox(_ sender: Any?) { find() }
}

@MainActor enum MainMenu {
    static func make(_ actions: MenuActions) -> NSMenu {
        let main = NSMenu(title: "Main")

        let app = NSMenu(title: "Lumen")
        add(app, "Settings…", #selector(MenuActions.openSettings(_:)), ",", target: actions)
        app.addItem(.separator())
        let services = NSMenu(title: "Services")
        let servicesItem = NSMenuItem(title: "Services", action: nil, keyEquivalent: "")
        servicesItem.submenu = services
        app.addItem(servicesItem)
        NSApplication.shared.servicesMenu = services
        app.addItem(.separator())
        add(app, "Close Capsule", #selector(MenuActions.closeCapsule(_:)), "q", target: actions)
        sub(main, app)

        let edit = NSMenu(title: "Edit")
        add(edit, "Undo", Selector(("undo:")), "z")
        add(edit, "Redo", Selector(("redo:")), "z", [.command, .shift])
        edit.addItem(.separator())
        add(edit, "Cut", #selector(NSText.cut(_:)), "x")
        add(edit, "Copy", #selector(NSText.copy(_:)), "c")
        add(edit, "Paste", #selector(NSText.paste(_:)), "v")
        add(edit, "Paste and Match Style", #selector(NSTextView.pasteAsPlainText(_:)), "v", [.command, .option, .shift])
        add(edit, "Delete", #selector(NSText.delete(_:)), "")
        add(edit, "Select All", #selector(NSText.selectAll(_:)), "a")
        edit.addItem(.separator())
        add(edit, "Find…", #selector(MenuActions.findInBox(_:)), "f", target: actions)
        edit.addItem(.separator())
        add(edit, "Emoji & Symbols", #selector(NSApplication.orderFrontCharacterPalette(_:)), " ", [.command, .control])
        sub(main, edit)

        let window = NSMenu(title: "Window")
        add(window, "Close", #selector(MenuActions.closeCapsule(_:)), "w", target: actions)
        sub(main, window)
        return main
    }

    /// The item a key event would pick: same key and the same Command, Shift, Option and Control.
    static func item(for e: NSEvent, in menu: NSMenu?) -> NSMenuItem? {
        guard let menu, let key = e.charactersIgnoringModifiers?.lowercased(), !key.isEmpty else { return nil }
        let mods = e.modifierFlags.intersection([.command, .shift, .option, .control])
        for i in menu.items {
            if let s = i.submenu, let hit = item(for: e, in: s) { return hit }
            guard !i.keyEquivalent.isEmpty, i.keyEquivalent.lowercased() == key else { continue }
            // "Z" with Shift reads as "z" here; the item names Shift in its mask.
            if i.keyEquivalentModifierMask.intersection([.command, .shift, .option, .control]) == mods { return i }
        }
        return nil
    }

    private static func add(_ m: NSMenu, _ title: String, _ action: Selector, _ key: String, _ mods: NSEvent.ModifierFlags = .command, target: AnyObject? = nil) {
        let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
        i.keyEquivalentModifierMask = key.isEmpty ? [] : mods
        i.target = target
        m.addItem(i)
    }

    private static func sub(_ main: NSMenu, _ m: NSMenu) {
        let i = NSMenuItem(title: m.title, action: nil, keyEquivalent: "")
        i.submenu = m
        main.addItem(i)
    }
}
