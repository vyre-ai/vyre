// VyreMenu: the full menu bar while the Vyre app window is open (VyreAppWindow.swift). Lumen alone is an accessory app with only the standard-shortcuts
// menu (MainMenu.swift); the window makes it a regular app, so it needs a real one. Every command that moves around the app sends a route to the page
// (window.__vyreShell._command), so the places and the shortcuts are the same as the tab bar's (screens/shell/nav.ts).
//
//   Vyre   About · Settings… ⌘, · Services · Hide ⌘H · Close Vyre ⌘Q (hides; Lumen keeps its hot keys)
//   File   New Chat ⌘N · Search ⌘K · Close Window ⌘W
//   Edit   the standard text commands
//   View   Now ⌘1 · Chat ⌘2 · Projects ⌘3 · Contacts ⌘4 · Drive ⌘5 · Calendar ⌘6 · Memory ⌘7 · Vault ⌘8 · Reload ⌘R · Zoom ⌘+ ⌘- ⌘0 · Full Screen ⌃⌘F
//   Go     Back ⌘[ · Forward ⌘]
//   Window Minimize ⌘M · Zoom · Bring All to Front        Help  Vyre Help

import AppKit

@MainActor enum VyreMenu {
    static let places: [(title: String, route: String, key: String)] = [
        ("Now", "/u/now", "1"), ("Chat", "/u/chats", "2"), ("Projects", "/u/projects", "3"), ("Contacts", "/u/records/contact", "4"),
        ("Drive", "/u/drive", "5"), ("Calendar", "/u/calendar", "6"), ("Memory", "/u/memory", "7"), ("Vault", "/u/vault", "8"),
    ]

    static func make(_ app: VyreAppWindow) -> NSMenu {
        let main = NSMenu(title: "Main")

        let vyre = NSMenu(title: "Vyre")
        add(vyre, "About Vyre", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), "", target: NSApp)
        vyre.addItem(.separator())
        go(vyre, app, "Settings…", "/u/settings", ",")
        vyre.addItem(.separator())
        let services = NSMenu(title: "Services")
        let servicesItem = NSMenuItem(title: "Services", action: nil, keyEquivalent: "")
        servicesItem.submenu = services
        vyre.addItem(servicesItem)
        NSApplication.shared.servicesMenu = services
        vyre.addItem(.separator())
        add(vyre, "Hide Vyre", #selector(NSApplication.hide(_:)), "h", target: NSApp)
        add(vyre, "Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option], target: NSApp)
        add(vyre, "Show All", #selector(NSApplication.unhideAllApplications(_:)), "", target: NSApp)
        vyre.addItem(.separator())
        add(vyre, "Close Vyre", #selector(VyreAppWindow.menuClose(_:)), "q", target: app)
        sub(main, vyre)

        let file = NSMenu(title: "File")
        go(file, app, "New Chat", "/u/chats", "n")
        go(file, app, "Search", "/u/search", "k")
        file.addItem(.separator())
        add(file, "Close Window", #selector(VyreAppWindow.menuClose(_:)), "w", target: app)
        sub(main, file)

        let edit = NSMenu(title: "Edit")
        add(edit, "Undo", Selector(("undo:")), "z")
        add(edit, "Redo", Selector(("redo:")), "z", [.command, .shift])
        edit.addItem(.separator())
        add(edit, "Cut", #selector(NSText.cut(_:)), "x")
        add(edit, "Copy", #selector(NSText.copy(_:)), "c")
        add(edit, "Paste", #selector(NSText.paste(_:)), "v")
        add(edit, "Paste and Match Style", #selector(NSTextView.pasteAsPlainText(_:)), "v", [.command, .option, .shift])
        add(edit, "Select All", #selector(NSText.selectAll(_:)), "a")
        edit.addItem(.separator())
        add(edit, "Emoji & Symbols", #selector(NSApplication.orderFrontCharacterPalette(_:)), " ", [.command, .control])
        sub(main, edit)

        let view = NSMenu(title: "View")
        for p in places { go(view, app, p.title, p.route, p.key) }
        view.addItem(.separator())
        add(view, "Reload", #selector(VyreAppWindow.menuReload(_:)), "r", target: app)
        zoom(view, app, "Actual Size", "0", 0)
        zoom(view, app, "Zoom In", "+", 1)
        zoom(view, app, "Zoom Out", "-", -1)
        view.addItem(.separator())
        add(view, "Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control])
        sub(main, view)

        let goMenu = NSMenu(title: "Go")
        go(goMenu, app, "Back", "back", "[")
        go(goMenu, app, "Forward", "forward", "]")
        sub(main, goMenu)

        let window = NSMenu(title: "Window")
        add(window, "Minimize", #selector(NSWindow.performMiniaturize(_:)), "m")
        add(window, "Zoom", #selector(NSWindow.performZoom(_:)), "")
        window.addItem(.separator())
        add(window, "Bring All to Front", #selector(NSApplication.arrangeInFront(_:)), "", target: NSApp)
        NSApp.windowsMenu = window
        sub(main, window)

        let help = NSMenu(title: "Help")
        add(help, "Vyre Help", #selector(VyreAppWindow.menuHelp(_:)), "?", target: app)
        sub(main, help)
        NSApp.helpMenu = help
        return main
    }

    private static func go(_ m: NSMenu, _ app: VyreAppWindow, _ title: String, _ route: String, _ key: String) {
        let i = NSMenuItem(title: title, action: #selector(VyreAppWindow.menuGo(_:)), keyEquivalent: key)
        i.keyEquivalentModifierMask = .command
        i.representedObject = route
        i.target = app
        m.addItem(i)
    }

    private static func zoom(_ m: NSMenu, _ app: VyreAppWindow, _ title: String, _ key: String, _ tag: Int) {
        let i = NSMenuItem(title: title, action: #selector(VyreAppWindow.menuZoom(_:)), keyEquivalent: key)
        i.keyEquivalentModifierMask = .command
        i.tag = tag
        i.target = app
        m.addItem(i)
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
