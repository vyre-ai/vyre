// capsule-suite: bindingsSuite
// Aliases and per-command hot keys: the model, the registrar (a fake, so no key is taken from
// macOS), the ⌘K entries, the box while one is set, and a hotkey press.

import AppKit
import Foundation

@MainActor
private final class FakeRegistrar: HotkeyRegistrar {
    var live: [String: String] = [:]       // tag -> spec
    var fires: [String: () -> Void] = [:]
    var taken: Set<String> = []            // specs another app holds
    func register(_ spec: String, tag: String, fire: @escaping @MainActor () -> Void) -> Bool {
        if taken.contains(spec) { return false }
        live[tag] = spec; fires[tag] = { fire() }
        return true
    }
    func unregister(tag: String) { live[tag] = nil; fires[tag] = nil }
    func press(_ tag: String) { fires[tag]?() }
}

private func scratch(_ name: String) -> String {
    let h = vyScratch("bind-\(name)-\(UUID().uuidString.prefix(6))")
    try? FileManager.default.removeItem(atPath: h + "/capsule")
    return h
}

private func appRow(_ name: String, kind: String = "app", id: String? = nil, actions: [ResultAction] = []) -> ResultItem {
    ResultItem(id: id ?? "app:/Applications/\(name).app", kind: kind, title: name, subtitle: "/Applications", icon: .symbol("app"),
               section: .apps, score: 0.5, actions: actions)
}

let bindingsSuite = Suite("bindings") { t in
    t.test("aliases: one lowercase word of letters, digits and . - _, up to 12") {
        t.eq(Bindings.cleanAlias("  SF "), "sf")
        t.eq(Bindings.cleanAlias("a.b-c_9"), "a.b-c_9")
        for bad in ["", "two words", "waytoolongalias", "a/b", "é!"] { t.ok(Bindings.cleanAlias(bad) == nil, bad) }
    }

    t.test("shortcuts: a key and its modifiers make one spelling; a bare key or Shift alone is refused; macOS's own are reserved") {
        t.eq(HotkeySpec.spec(keyCode: 1, command: false, option: true, control: true, shift: false), "ctrl+option+s")
        t.eq(HotkeySpec.spec(keyCode: 1, command: true, option: true, control: true, shift: true), "ctrl+option+shift+cmd+s")
        t.ok(HotkeySpec.spec(keyCode: 1, command: false, option: false, control: false, shift: false) == nil)
        t.ok(HotkeySpec.spec(keyCode: 1, command: false, option: false, control: false, shift: true) == nil)
        t.ok(HotkeySpec.spec(keyCode: 200, command: true, option: false, control: false, shift: false) == nil, "no such key")
        t.eq(HotkeySpec.normal("Option+CTRL+S"), "ctrl+option+s")
        t.eq(HotkeySpec.normal("command+space"), "cmd+space")
        t.ok(HotkeySpec.normal("s") == nil && HotkeySpec.normal("ctrl+") == nil && HotkeySpec.normal("ctrl+s+d") == nil)
        t.ok(HotkeySpec.isReserved("cmd+space") && HotkeySpec.isReserved("option+space") && !HotkeySpec.isReserved("ctrl+option+s"))
        t.eq(HotkeySpec.pretty("ctrl+option+s"), "\u{2303}\u{2325}S")
        t.ok(HotkeySpec.parse("cmd+option+f5") != nil)
    }

    t.test("the list: set, refuse a taken alias or shortcut, clear, and an empty binding disappears") {
        var b = Bindings()
        t.eq(b.setAlias("sf", id: "app:/Safari", title: "Safari"), nil)
        t.ok(b.setAlias("SF", id: "app:/Slack", title: "Slack") != nil, "another owns it")
        t.eq(b.setAlias("SF", id: "app:/Safari", title: "Safari"), nil, "the same owner may say it again")
        t.ok(b.setAlias("no good", id: "x", title: "X") != nil)
        t.eq(b.setHotkey("option+ctrl+s", id: "app:/Safari", title: "Safari"), nil)
        t.eq(b.binding(for: "app:/Safari")?.hotkey, "ctrl+option+s")
        t.ok(b.setHotkey("ctrl+option+s", id: "app:/Slack", title: "Slack") != nil)
        t.ok(b.setHotkey("cmd+space", id: "app:/Slack", title: "Slack") != nil)
        t.ok(b.setHotkey("s", id: "app:/Slack", title: "Slack") != nil)
        t.eq(b.byAlias("Sf")?.id, "app:/Safari"); t.eq(b.byHotkey("ctrl+option+s")?.id, "app:/Safari")
        b.clearAlias(id: "app:/Safari"); t.eq(b.items.count, 1)
        b.clearHotkey(id: "app:/Safari"); t.eq(b.items.count, 0)
    }

    t.test("the file round-trips; a bad or doubled entry is dropped on load") {
        let h = scratch("file"), path = h + "/capsule/bindings.json"
        var b = Bindings()
        _ = b.setAlias("sf", id: "app:/Safari", title: "Safari"); _ = b.setHotkey("ctrl+option+s", id: "app:/Safari", title: "Safari")
        t.ok(b.save(path: path))
        t.eq(Bindings.load(path: path), b)
        let bad = #"{"bindings":[{"id":"a","title":"A","alias":"same"},{"id":"b","title":"B","alias":"same","hotkey":"cmd+space"},{"id":"c","title":"C","hotkey":"nope"},{"id":"","alias":"x"},{"id":"d","alias":"ok","hotkey":"ctrl+option+d"}]}"#
        try? Data(bad.utf8).write(to: URL(fileURLWithPath: path))
        let l = Bindings.load(path: path)
        t.eq(l.items.map(\.id), ["a", "d"])
        t.eq(Bindings.load(path: h + "/none.json").items.count, 0)
    }

    t.test("start registers the saved hotkeys; a press rebuilds the row and fires it; another app's key is refused with the old one kept") {
        MainActor.assumeIsolated {
            let h = scratch("start")
            var seed = Bindings(); _ = seed.setHotkey("ctrl+option+s", id: "app:/Safari", title: "Safari"); _ = seed.save(path: h + "/capsule/bindings.json")
            let reg = FakeRegistrar()
            let cb = CommandBindings(home: h, registrar: reg)
            var fired: [String] = []
            cb.resolve = { id in appRow(id == "app:/Safari" ? "Safari" : "Other", id: id) }
            cb.fire = { fired.append($0.title) }
            cb.start()
            t.eq(reg.live["app:/Safari"], "ctrl+option+s")
            reg.press("app:/Safari")
            t.eq(fired, ["Safari"])
            reg.taken = ["ctrl+option+t"]
            t.ok(cb.setHotkey("ctrl+option+t", id: "app:/Safari", title: "Safari")?.contains("taken by another app") == true)
            t.eq(reg.live["app:/Safari"], "ctrl+option+s", "the old key still works")
            t.eq(cb.setHotkey("ctrl+option+r", id: "app:/Safari", title: "Safari"), nil)
            t.eq(reg.live["app:/Safari"], "ctrl+option+r")
            cb.clearHotkey("app:/Safari")
            t.eq(reg.live.count, 0)
            t.eq(Bindings.load(path: h + "/capsule/bindings.json").items.count, 0)
        }
    }

    t.test("an alias brings its row first, marked; only rows that can be rebuilt get the ⌘K entries") {
        MainActor.assumeIsolated {
            let cb = CommandBindings(home: scratch("alias"), registrar: FakeRegistrar())
            cb.resolve = { appRow("Safari", id: $0) }
            t.eq(cb.setAlias("sf", id: "app:/Safari", title: "Safari"), nil)
            let r = cb.aliasRow("sf")
            t.eq(r?.title, "Safari"); t.eq(r?.score, 1.5); t.ok(r?.subtitle.hasPrefix("alias sf") == true)
            t.ok(cb.aliasRow("s") == nil && cb.aliasRow("") == nil)
            let d = cb.decorated(appRow("Safari"), begin: { _ in })
            t.eq(d.actions.map(\.id), ["set-alias", "set-hotkey"])
            let d2 = cb.decorated(appRow("Safari", id: "app:/Applications/Safari.app"), begin: { _ in })
            t.eq(d2.actions.first { $0.id == "set-alias" }?.title, "Set alias")
            _ = cb.setAlias("sf", id: "app:/Applications/Safari.app", title: "Safari")
            let d3 = cb.decorated(appRow("Safari"), begin: { _ in })
            t.eq(d3.actions.map(\.title), ["Change alias", "Set hotkey", "Remove alias"])
            t.eq(cb.decorated(appRow("A file", kind: "file"), begin: { _ in }).actions.count, 0, "a file is not bindable")
        }
    }

    t.test("in the box: Set alias asks in one row, Return saves it, and typing the alias then finds the row first") {
        MainActor.assumeIsolated {
            let h = scratch("box")
            let v = FakeVyred()
            let m = CapsuleModel(home: h, vyred: VyredClient(socket: v.socket), providers: [])
            let cb = CommandBindings(home: h, registrar: FakeRegistrar())
            m.attach(bindings: cb)
            cb.resolve = { appRow("Safari", id: $0) }
            m.beginBinding(BindingEdit(id: "app:/Applications/Safari.app", title: "Safari", field: .alias))
            t.eq(m.flat.count, 1); t.eq(m.flat.first?.title, "Type an alias for Safari")
            m.text = "no good"
            t.eq(m.saveAlias(), .said("An alias is one word, up to 12 letters, digits, dots, dashes or underscores."))
            t.ok(m.bindingEdit?.problem != nil)
            m.text = "SF"
            t.eq(m.flat.first?.title, "Alias \u{201C}SF\u{201D} for Safari")
            if case .said(let s) = m.saveAlias() { t.ok(s.contains("set for Safari"), s) } else { t.ok(false, "not said") }
            t.ok(m.bindingEdit == nil); t.eq(m.text, "")
            m.text = "sf"
            t.eq(m.flat.first?.title, "Safari"); t.eq(m.flat.first?.kind, "app")
        }
    }

    t.test("in the box: Set hotkey takes the next shortcut, refuses a bare key, and Esc leaves") {
        MainActor.assumeIsolated {
            let h = scratch("hk")
            let v = FakeVyred()
            let m = CapsuleModel(home: h, vyred: VyredClient(socket: v.socket), providers: [])
            let cb = CommandBindings(home: h, registrar: FakeRegistrar())
            m.attach(bindings: cb)
            m.beginBinding(BindingEdit(id: "app:/Applications/Safari.app", title: "Safari", field: .hotkey))
            t.eq(m.flat.first?.title, "Press the shortcut for Safari")
            t.eq(m.captureHotkey(keyCode: 1, command: false, option: false, control: false, shift: false), true)
            t.eq(m.bindingEdit?.problem, "Hold Command, Option or Control with a key.")
            t.eq(m.captureHotkey(keyCode: 49, command: true, option: false, control: false, shift: false), true)
            t.ok(m.bindingEdit?.problem?.contains("macOS") == true, "cmd+space is reserved")
            t.eq(m.captureHotkey(keyCode: 1, command: false, option: true, control: true, shift: false), true)
            t.ok(m.bindingEdit == nil)
            t.eq(cb.store.binding(for: "app:/Applications/Safari.app")?.hotkey, "ctrl+option+s")
            m.beginBinding(BindingEdit(id: "x", title: "X", field: .hotkey))
            t.eq(m.captureHotkey(keyCode: 53, command: false, option: false, control: false, shift: false), true)
            t.ok(m.bindingEdit == nil)
        }
    }

    t.test("a hotkey runs a plain row at once, and opens the Capsule on one that asks first") {
        let ran = OvCounter()
        let shown: [String]? = t.wait { @MainActor () -> [String] in
            let h = scratch("run")
            let v = FakeVyred()
            let m = CapsuleModel(home: h, vyred: VyredClient(socket: v.socket), providers: [])
            let cb = CommandBindings(home: h, registrar: FakeRegistrar())
            m.attach(bindings: cb)
            var shown: [String] = []
            m.onShow = { shown.append($0) }
            let plain = appRow("Safari", actions: [ResultAction(id: "open", title: "Open") { _, _ in ran.bump(); return .close(nil) }])
            let risky = appRow("Restart", kind: "system", id: "system:restart",
                               actions: [ResultAction(id: "run", title: "Restart", confirm: "Restart now?") { _, _ in ran.bump(); return .close(nil) }])
            m.runFromHotkey(plain)
            m.runFromHotkey(risky)
            try? await Task.sleep(nanoseconds: 100_000_000)
            return shown
        }
        t.eq(ran.count, 1, "only the plain row ran")
        t.eq(shown, ["Restart"])
    }
}

final class OvCounter: @unchecked Sendable {
    private let lock = NSLock(); private var n = 0
    var count: Int { lock.withLock { n } }
    func bump() { lock.withLock { n += 1 } }
}
