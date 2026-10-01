// CommandBindings: aliases and hotkeys on the Capsule's rows (Core/Bindings.swift is the model).
//
//   - An alias is a word you type; the row it names comes first.
//   - A hotkey runs a row from anywhere without opening a window. A row that must ask first (a
//     shell line, Restart) opens the Capsule on it instead, so nothing risky runs from one key.
//   - ⌘K on an app, a system command, or one of your own snippets, quicklinks and commands lists
//     "Set alias", "Set hotkey" and, when set, "Remove ...". Setting one uses the box: type the
//     alias and press Return, or press the shortcut. Esc leaves.
//
// The file is <home>/capsule/bindings.json. Hotkeys are Carbon hot keys, which need no permission.
// Nothing here runs or polls while the Capsule is hidden except the keys themselves, which cost
// nothing until pressed.

import AppKit
import Carbon.HIToolbox
import Foundation

/// A provider that can rebuild a row from its stable id, for an alias or a hotkey.
protocol RowResolver: AnyObject {
    func row(forID id: String) -> ResultItem?
}

/// Where hot keys are registered with macOS. A fake in tests.
@MainActor
protocol HotkeyRegistrar: AnyObject {
    /// Register `spec`; `fire` runs when it is pressed. False if another app already holds it.
    func register(_ spec: String, tag: String, fire: @escaping @MainActor () -> Void) -> Bool
    func unregister(tag: String)
}

@MainActor
final class CarbonRegistrar: HotkeyRegistrar {
    static let signature = OSType(0x5659_4244) // "VYBD"
    private var refs: [String: (ref: EventHotKeyRef, id: UInt32)] = [:]
    private var fires: [UInt32: () -> Void] = [:]
    private var next: UInt32 = 100
    private var handler: EventHandlerRef?

    func register(_ spec: String, tag: String, fire: @escaping @MainActor () -> Void) -> Bool {
        guard let (key, mods) = HotkeySpec.parse(spec) else { return false }
        unregister(tag: tag)
        if handler == nil {
            var type = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
            let me = Unmanaged.passUnretained(self).toOpaque()
            InstallEventHandler(GetApplicationEventTarget(), { _, event, info in
                var hk = EventHotKeyID()
                GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil,
                                  MemoryLayout<EventHotKeyID>.size, nil, &hk)
                guard hk.signature == CarbonRegistrar.signature else { return OSStatus(eventNotHandledErr) }
                let me = Unmanaged<CarbonRegistrar>.fromOpaque(info!).takeUnretainedValue()
                MainActor.assumeIsolated { me.fires[hk.id]?() }
                return noErr
            }, 1, &type, me, &handler)
        }
        let id = next; next += 1
        var ref: EventHotKeyRef?
        guard RegisterEventHotKey(key, mods, EventHotKeyID(signature: Self.signature, id: id), GetApplicationEventTarget(), 0, &ref) == noErr, let ref else { return false }
        refs[tag] = (ref, id)
        fires[id] = fire
        return true
    }

    func unregister(tag: String) {
        guard let (ref, id) = refs.removeValue(forKey: tag) else { return }
        UnregisterEventHotKey(ref)
        fires[id] = nil
    }
}

/// What the box is being used for while an alias or a hotkey is set.
struct BindingEdit: Equatable {
    enum Field: Equatable { case alias, hotkey }
    var id: String
    var title: String
    var field: Field
    /// Why the last try was refused, shown under the prompt.
    var problem: String?
}

@MainActor
final class CommandBindings {
    let path: String
    private(set) var store: Bindings
    private let registrar: HotkeyRegistrar
    /// Rebuild a row from its id (the model's providers).
    var resolve: (String) -> ResultItem? = { _ in nil }
    /// A hotkey was pressed for this row: the model runs it.
    var fire: (ResultItem) -> Void = { _ in }
    /// The list changed: search again if the box holds an alias.
    var changed: () -> Void = {}
    /// Why a key could not be taken at start (another app has it), one line each, for the log.
    private(set) var refused: [String] = []

    init(home: String, registrar: HotkeyRegistrar? = nil) {
        path = (home as NSString).appendingPathComponent("capsule/bindings.json")
        store = Bindings.load(path: path)
        self.registrar = registrar ?? CarbonRegistrar()
    }

    /// Register every saved hotkey. Called once at launch.
    func start() {
        for b in store.items { if let h = b.hotkey { arm(b.id, h) } }
    }

    private func arm(_ id: String, _ spec: String) {
        let ok = registrar.register(spec, tag: id) { [weak self] in self?.pressed(id) }
        if !ok { refused.append("\(HotkeySpec.pretty(spec)) for \(store.binding(for: id)?.title ?? id)") }
    }

    private func pressed(_ id: String) {
        guard let row = resolve(id) else { return }
        fire(row)
    }

    // MARK: use

    /// The row an alias names, ranked first and marked with the alias, when the words typed are one.
    func aliasRow(_ words: String) -> ResultItem? {
        guard let b = store.byAlias(words), var r = resolve(b.id) else { return nil }
        r.score = 1.5
        r.subtitle = r.subtitle.isEmpty ? "alias \(b.alias ?? "")" : "alias \(b.alias ?? "") \u{00B7} \(r.subtitle)"
        return r
    }

    /// Rows that can carry an alias or a hotkey: the ones `resolve` can rebuild.
    static func canBind(_ r: ResultItem) -> Bool {
        ["app", "system", "snippet", "quicklink", "user-command"].contains(r.kind)
    }

    /// The row with its ⌘K entries for aliases and hotkeys, and the shortcut it has, shown in its words.
    func decorated(_ r: ResultItem, begin: @escaping @Sendable (BindingEdit) async -> Void) -> ResultItem {
        guard Self.canBind(r), !r.id.isEmpty else { return r }
        var x = r
        let b = store.binding(for: r.id)
        let id = r.id, title = r.title
        x.actions.append(ResultAction(id: "set-alias", title: b?.alias == nil ? "Set alias" : "Change alias", symbol: "textformat.abc") { _, _ in
            await begin(BindingEdit(id: id, title: title, field: .alias)); return .said("")
        })
        x.actions.append(ResultAction(id: "set-hotkey", title: b?.hotkey == nil ? "Set hotkey" : "Change hotkey", symbol: "command") { _, _ in
            await begin(BindingEdit(id: id, title: title, field: .hotkey)); return .said("")
        })
        if b?.alias != nil {
            x.actions.append(ResultAction(id: "clear-alias", title: "Remove alias", symbol: "xmark.circle") { [weak self] _, _ in
                await MainActor.run { self?.clearAlias(id) }; return .said("Alias removed")
            })
        }
        if b?.hotkey != nil {
            x.actions.append(ResultAction(id: "clear-hotkey", title: "Remove hotkey", symbol: "xmark.circle") { [weak self] _, _ in
                await MainActor.run { self?.clearHotkey(id) }; return .said("Hotkey removed")
            })
        }
        return x
    }

    // MARK: change. Each returns why not, or nil.

    func setAlias(_ raw: String, id: String, title: String) -> String? {
        var s = store
        if let why = s.setAlias(raw, id: id, title: title) { return why }
        store = s
        return persist() ? nil : "The alias could not be saved."
    }

    func setHotkey(_ spec: String, id: String, title: String) -> String? {
        var s = store
        if let why = s.setHotkey(spec, id: id, title: title) { return why }
        let normal = HotkeySpec.normal(spec) ?? spec
        // Take it from macOS first: another app may hold it.
        if !registrar.register(normal, tag: id, fire: { [weak self] in self?.pressed(id) }) {
            if let old = store.binding(for: id)?.hotkey { arm(id, old) }
            return "\(HotkeySpec.pretty(normal)) is taken by another app."
        }
        store = s
        return persist() ? nil : "The hotkey could not be saved."
    }

    func clearAlias(_ id: String) { store.clearAlias(id: id); _ = persist() }

    func clearHotkey(_ id: String) {
        store.clearHotkey(id: id)
        registrar.unregister(tag: id)
        _ = persist()
    }

    private func persist() -> Bool {
        let ok = store.save(path: path)
        changed()
        return ok
    }
}
