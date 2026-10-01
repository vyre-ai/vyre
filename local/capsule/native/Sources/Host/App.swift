// App: the Capsule's process. A menu-bar app with no Dock icon (LSUIElement): the panel, the hot
// keys, the menu-bar item, and one link to vyred. Nothing polls while the panel is hidden; the
// vyred follower backs off to a minute, and the event tap only wakes on key events.

import AppKit
import Combine
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
    let menuActions = MenuActions()
    lazy var health = Health(vyred: vyred)
    lazy var presence = CapsulePresence(home: home, vyred: vyred)
    /// Emoji, colours, time zones, money, snippets, quicklinks and your commands (LocalAnswers.swift).
    let local: LocalAnswersProvider
    /// Commands modules declare for the Capsule (ViewCommandsProvider.swift).
    let viewCommands: ViewCommandsProvider
    var viewSub: VyredSubscription?
    var loosenedSub: VyredSubscription?
    /// The box's alarms and reminders ringing here, from /v1/link/events (Planner.swift).
    lazy var planner = PlannerBanners(vyred: vyred)
    /// Clipboard, contacts, modules, Glass and watches (Agent/AgentWiring.swift).
    let wiring: AgentWiring
    /// The menu-bar item's button, for the attention mark (Agent/AgentMenuBar.swift).
    var status: NSStatusItem? { menuBar?.item }
    /// Repaints the mark when the waiting list changes (Agent/AgentMenuBar.swift).
    var agentSink: AnyCancellable?

    override init() {
        let env = ProcessInfo.processInfo.environment
        home = env["VYRE_HOME"].flatMap { $0.isEmpty ? nil : $0 } ?? (NSHomeDirectory() as NSString).appendingPathComponent(".vyre")
        vyred = VyredClient(socket: vyredSocketPath(env))
        wiring = AgentWiring(home: home, vyred: vyred)
        Paster.prefsPath = (home as NSString).appendingPathComponent("capsule/prefs.json")
        local = LocalAnswersProvider(home: home)
        viewCommands = ViewCommandsProvider(vyred: vyred)
        model = CapsuleModel(home: home, vyred: vyred, providers: [
            AppsProvider(), SettingsProvider(), FilesProvider(), DictionaryProvider(), local, WindowsProvider(), viewCommands,
        ] + wiring.providers)
        super.init()
        local.onChange = { [weak self] in Task { @MainActor in self?.model.refresh() } }
        model.attach(views: viewCommands)
    }

    func applicationDidFinishLaunching(_ note: Notification) {
        panel = PanelController(model: model)
        let bindings = CommandBindings(home: home)
        model.attach(bindings: bindings)
        model.onShow = { [weak self] words in
            guard let self else { return }
            self.panel.show(front: PanelController.frontApp())
            self.model.text = words
        }
        if !(ProcessInfo.processInfo.environment["VYRE_CAPSULE_HEADLESS"] == "1") { bindings.start() }
        extensions = ExtensionHost(model: model)
        extensions.panel = panel
        panel.extensions = extensions
        extensions.load(extensionTypes)
        // The standard shortcuts need a main menu to live in (MainMenu.swift); never shown.
        menuActions.hide = { [weak self] in self?.panel.hide() }
        menuActions.settings = { [weak self] in self?.panel.hide(); self?.menuBar?.open() }
        menuActions.find = { [weak self] in
            guard let p = self?.panel else { return }
            p.focus.count += 1
            DispatchQueue.main.async { NSApp.sendAction(#selector(NSText.selectAll(_:)), to: p.panel.firstResponder, from: nil) }
        }
        NSApp.mainMenu = MainMenu.make(menuActions)
        // VYRE_CAPSULE_HEADLESS=1: no hot keys and no menu-bar item, for footprint checks that
        // must not take the user's keys or add a second mark to his menu bar.
        let headless = ProcessInfo.processInfo.environment["VYRE_CAPSULE_HEADLESS"] == "1"
        hotkeys.fire = { [weak self] front in self?.panel.toggle(front: front) }
        hotkeys.onChange = { [weak self] ok, message in self?.reportHotkeys(ok: ok, message: message) }
        if !headless { hotkeys.start() }
        (model.providers.first as? AppsProvider)?.refreshIfChanged(wait: false)
        // Human-only calls (ADR 0004): "Confirm it's you" in the panel, then the Capsule's key signs.
        presence.ask = { [weak self] a in
            guard let self else { return false }
            if !self.panel.isShown { self.panel.show(front: PanelController.frontApp()) }
            return await self.model.askPresence(a)
        }
        let presence = self.presence
        vyred.presenceProof = { tool, input, summary in
            let box = UncheckedBox(input)
            return await MainActor.run { presence }.proofFromAnyThread(tool: tool, input: box, summary: summary)
        }
        // The presence session lives in memory only: the Mac locking or sleeping ends it.
        let ws = NSWorkspace.shared.notificationCenter
        for n in [NSWorkspace.willSleepNotification, NSWorkspace.sessionDidResignActiveNotification, NSWorkspace.screensDidSleepNotification] {
            ws.addObserver(forName: n, object: nil, queue: .main) { [vyred] _ in vyred.dropPresenceSession() }
        }
        DistributedNotificationCenter.default().addObserver(forName: .init("com.apple.screenIsLocked"), object: nil, queue: .main) { [vyred] _ in
            vyred.dropPresenceSession()
        }
        vyred.follower.onState = { [weak self] st in
            self?.health.set(up: st == .open)
            if st == .open {
                self?.hotkeys.reportRetry()
                Task { await self?.presence.pinSelf() }
            }
        }
        vyred.follower.start()
        panel.onShownChange = { [weak self] shown in if shown { self?.health.refresh() } else { self?.menuBar?.close() } }
        if !headless { makeStatusItem() }
        // The agent half (Agent/): the waiting list and its attention dot, the wired providers,
        // capsule.requested, and the driven mode.
        followWaiting()
        wiring.attach(model)
        wiring.requested = { [weak self] action in
            guard let self else { return }
            switch action {
            case "hide": self.panel.hide()
            case "toggle": self.panel.toggle()
            default: if !self.panel.isShown { self.panel.show(front: PanelController.frontApp()) }
            }
        }
        Drive.start(self)
        // Kept open while hidden, on purpose: a timer on the box has to ring here.
        if !headless { planner.start() }
        // A module says its commands changed: read them again (never polled).
        viewSub = vyred.on("capsule.changed") { [weak self] _ in self?.viewCommands.read(force: true) }
        loosenedSub = vyred.on("settings.loosened") { [weak self] e in self?.model.noticeLoosened(e.payload) }
        enrolWithCore()
        if !headless { LumenOpen.showIfFirst() }
        // Once the launch has settled, draw the panel once in the dark (never shown): the first summon is then warm.
        if ProcessInfo.processInfo.environment["VYRE_CAPSULE_NO_PREWARM"] != "1" {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in MainActor.assumeIsolated { self?.panel.prewarm() } }
        }
        if ProcessInfo.processInfo.environment["VYRE_CAPSULE_OPEN"] == "1" { panel.show(front: PanelController.frontApp()) }
    }

    /// The first key on a Mac that runs vyre-core: the installer's code from fd 3 (CoreEnroll.swift).
    /// The result is said in the panel, and in a notification if it is hidden.
    func enrolWithCore() {
        let handoff = CoreEnroll.handoff
        guard handoff != .absent else { return }
        let presence = self.presence
        Task { [weak self] in
            guard let out = await CoreEnroll.enrol(handoff, presence: presence, config: CoreEnroll.readConfig()) else { return }
            guard let self else { return }
            self.model.line = out.words
            if !self.panel.isShown { self.panel.show(front: PanelController.frontApp()) }
            if !out.enrolled { Notifier.shared.post(title: "Lumen", body: out.words) }
        }
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
            // Who is who, as last read; read again so the next open is current.
            Task { await self.model.loadIdentities() }
            return AnyView(MenuBarPopover(health: self.health, identities: self.model.identities, hotkeys: self.hotkeyWords, canTurnOnControl: !self.hotkeys.doubleControl,
                                   open: { [unowned self] in self.menuBar?.close(); self.openCapsule() },
                                   turnOnControl: { [unowned self] in self.menuBar?.close(); self.turnOnDoubleControl() },
                                   start: { [unowned self] in self.menuBar?.close(); self.openCapsule(); self.model.startVyre() },
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
        menu.addItem(withTitle: "Open Lumen", action: #selector(openCapsule), keyEquivalent: "").target = self
        addWaitingItem(menu)
        menu.addItem(.separator())
        if !hotkeys.doubleControl {
            menu.addItem(withTitle: "Turn on Control twice…", action: #selector(turnOnDoubleControl), keyEquivalent: "").target = self
        }
        let link = NSMenuItem(title: health.summary, action: nil, keyEquivalent: "")
        link.isEnabled = false
        menu.addItem(link)
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit Lumen", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
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

    /// capsule.report: whether Control twice works, and if not why, for `vyre doctor`. A failed
    /// send (vyred not up yet) goes again when the follower reconnects.
    func reportHotkeys(ok: Bool, message: String?) {
        var input: [String: Any] = ["ok": ok]
        if let message { input["message"] = message }
        let vyred = self.vyred
        Task { [weak self] in
            let r = await vyred.call("capsule.report", input, timeout: 5)
            if r.error != nil { self?.hotkeys.reportFailed(ok: ok, message: message) }
        }
    }

    @objc func openCapsule() { panel.show(front: PanelController.frontApp()) }
    @objc func turnOnDoubleControl() { hotkeys.requestDoubleControl() }

    /// Lumen lens as a template image, so the menu bar tints it for light and dark.
    static func menuBarMark() -> NSImage { LumenMark.menuBarImage() }
}
