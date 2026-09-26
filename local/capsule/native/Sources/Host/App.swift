// App: the Capsule's process. A menu-bar app with no Dock icon (LSUIElement): the panel, the hot
// keys, the menu-bar item, and one link to vyred. Nothing polls while the panel is hidden; the
// vyred follower backs off to a minute, and the event tap only wakes on key events.

import AppKit
import SwiftUI

@MainActor
final class CapsuleApp: NSObject, NSApplicationDelegate {
    let home: String
    let vyred: VyredClient
    let model: CapsuleModel
    var panel: PanelController!
    var extensions: ExtensionHost!
    let hotkeys = Hotkeys()
    var menuBar: MenuBarItem?
    lazy var health = Health(vyred: vyred)

    override init() {
        let env = ProcessInfo.processInfo.environment
        home = env["VYRE_HOME"].flatMap { $0.isEmpty ? nil : $0 } ?? (NSHomeDirectory() as NSString).appendingPathComponent(".vyre")
        vyred = VyredClient(socket: vyredSocketPath(env))
        model = CapsuleModel(home: home, vyred: vyred, providers: [
            AppsProvider(), SettingsProvider(), FilesProvider(), DictionaryProvider(),
        ])
        super.init()
    }

    func applicationDidFinishLaunching(_ note: Notification) {
        panel = PanelController(model: model)
        extensions = ExtensionHost(model: model)
        extensions.panel = panel
        panel.extensions = extensions
        extensions.load(extensionTypes)
        // VYRE_CAPSULE_HEADLESS=1: no hot keys and no menu-bar item, for footprint checks that
        // must not take the user's keys or add a second mark to his menu bar.
        let headless = ProcessInfo.processInfo.environment["VYRE_CAPSULE_HEADLESS"] == "1"
        hotkeys.fire = { [weak self] front in self?.panel.toggle(front: front) }
        if !headless { hotkeys.start() }
        (model.providers.first as? AppsProvider)?.refreshIfChanged(wait: false)
        vyred.follower.onState = { [weak self] st in self?.health.set(up: st == .open) }
        vyred.follower.start()
        panel.onShownChange = { [weak self] shown in if shown { self?.health.refresh() } else { self?.menuBar?.close() } }
        if !headless { makeStatusItem() }
        if ProcessInfo.processInfo.environment["VYRE_CAPSULE_OPEN"] == "1" { panel.show(front: PanelController.frontApp()) }
    }

    /// `open Vyre.app` while it runs opens the Capsule: a way in that needs no hot key at all.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        panel.toggle()
        return false
    }

    // MARK: the menu-bar item

    func makeStatusItem() {
        let bar = MenuBarItem(health: health)
        bar.content = { [unowned self] in
            AnyView(MenuBarPopover(health: self.health, hotkeys: self.hotkeyWords, canTurnOnControl: !self.hotkeys.doubleControl,
                                   open: { [unowned self] in self.menuBar?.close(); self.openCapsule() },
                                   turnOnControl: { [unowned self] in self.menuBar?.close(); self.turnOnDoubleControl() },
                                   quit: { NSApp.terminate(nil) }))
        }
        bar.menu = { [unowned self] in self.plainMenu() }
        menuBar = bar
    }

    var hotkeyWords: String {
        [hotkeys.doubleControl ? "⌃⌃" : nil, hotkeys.chord.map(Self.pretty)].compactMap { $0 }.joined(separator: " or ")
    }

    func plainMenu() -> NSMenu {
        let menu = NSMenu()
        menu.addItem(withTitle: "Open Capsule", action: #selector(openCapsule), keyEquivalent: "").target = self
        if !hotkeys.doubleControl {
            menu.addItem(withTitle: "Turn on Control twice…", action: #selector(turnOnDoubleControl), keyEquivalent: "").target = self
        }
        let link = NSMenuItem(title: health.summary, action: nil, keyEquivalent: "")
        link.isEnabled = false
        menu.addItem(link)
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit Vyre Capsule", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        return menu
    }

    static func pretty(_ chord: String) -> String {
        chord.split(separator: "+").map { p -> String in
            switch p.lowercased() {
            case "cmd", "command": return "⌘"
            case "option", "opt", "alt": return "⌥"
            case "ctrl", "control": return "⌃"
            case "shift": return "⇧"
            case "space": return "Space"
            default: return p.uppercased()
            }
        }.joined()
    }

    @objc func openCapsule() { panel.show(front: PanelController.frontApp()) }
    @objc func turnOnDoubleControl() { hotkeys.requestDoubleControl() }

    /// The mark as a template image, so the menu bar tints it for light and dark.
    static func menuBarMark() -> NSImage {
        let img = NSImage(size: NSSize(width: 18, height: 18), flipped: true) { r in
            let k = r.width / 16
            let p = NSBezierPath()
            p.move(to: NSPoint(x: 2.5 * k, y: 4 * k))
            p.line(to: NSPoint(x: 8 * k, y: 13 * k))
            p.line(to: NSPoint(x: 11.52 * k, y: 7.24 * k))
            p.lineWidth = 1.8 * k
            p.lineCapStyle = .round
            p.lineJoinStyle = .round
            NSColor.black.setStroke()
            p.stroke()
            NSColor.black.setFill()
            NSBezierPath(ovalIn: NSRect(x: (13.5 - 1.8) * k, y: (4 - 1.8) * k, width: 3.6 * k, height: 3.6 * k)).fill()
            return true
        }
        img.isTemplate = true
        return img
    }
}
