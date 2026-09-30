// BindingsUI: the Capsule's side of aliases and hotkeys (CommandBindings.swift): rebuilding a row
// from its id, setting one in the box, and running a row from a hotkey.

import AppKit
import Foundation

extension CapsuleModel {
    /// The row for a stable id, from whoever made it.
    func rebuildRow(_ id: String) -> ResultItem? {
        if id.hasPrefix("system:"), let c = SystemCommands.all.first(where: { "system:\($0.id)" == id }) { return commandItem(c, score: 1) }
        for p in providers + extensionProviders { if let r = (p as? RowResolver)?.row(forID: id) { return r } }
        return nil
    }

    /// Wire aliases and hot keys to this model. Called once by the app.
    func attach(bindings b: CommandBindings) {
        bindings = b
        b.resolve = { [weak self] id in self?.rebuildRow(id) }
        b.fire = { [weak self] row in self?.runFromHotkey(row) }
        b.changed = { [weak self] in self?.refresh() }
    }

    // MARK: setting one

    func beginBinding(_ e: BindingEdit) {
        bindingEdit = e
        line = nil
        text = ""                       // triggers search(), which draws the prompt row
        if text.isEmpty { search() }    // already empty: draw it anyway
    }

    func cancelBinding() {
        bindingEdit = nil
        text = ""
        search()
    }

    func bindingEditRow(_ e: BindingEdit) -> ResultItem {
        switch e.field {
        case .alias:
            let typed = text.trimmingCharacters(in: .whitespaces)
            let title = typed.isEmpty ? "Type an alias for \(e.title)" : "Alias \u{201C}\(typed)\u{201D} for \(e.title)"
            return ResultItem(id: "binding-edit", kind: "binding-edit", title: title, subtitle: e.problem ?? "Return saves it. Esc leaves.",
                              icon: .symbol("textformat.abc", .signal), section: .top, score: 1,
                              actions: [ResultAction(id: "save", title: "Save alias", symbol: "return") { [weak self] _, _ in
                                  await MainActor.run { self?.saveAlias() ?? .failed("Nothing to save.") }
                              }])
        case .hotkey:
            return ResultItem(id: "binding-edit", kind: "binding-edit", title: "Press the shortcut for \(e.title)",
                              subtitle: e.problem ?? "Hold Command, Option or Control with a key. Esc leaves.",
                              icon: .symbol("command", .signal), section: .top, score: 1, actions: [])
        }
    }

    func saveAlias() -> ActionOutcome {
        guard var e = bindingEdit, e.field == .alias, let b = bindings else { return .failed("Nothing to save.") }
        if let why = b.setAlias(text, id: e.id, title: e.title) {
            e.problem = why; bindingEdit = e
            search()
            return .said(why)
        }
        let done = "Alias \u{201C}\(text.trimmingCharacters(in: .whitespaces).lowercased())\u{201D} set for \(e.title)"
        bindingEdit = nil
        text = ""
        flash(done)
        return .said(done)
    }

    /// A key while a hotkey is being set: the shortcut pressed is the answer. Esc leaves.
    func captureHotkey(keyCode: UInt16, command: Bool, option: Bool, control: Bool, shift: Bool) -> Bool {
        guard var e = bindingEdit, e.field == .hotkey, let b = bindings else { return false }
        if keyCode == 53 { cancelBinding(); return true }
        guard let spec = HotkeySpec.spec(keyCode: keyCode, command: command, option: option, control: control, shift: shift) else {
            e.problem = "Hold Command, Option or Control with a key."; bindingEdit = e; search(); return true
        }
        if let why = b.setHotkey(spec, id: e.id, title: e.title) {
            e.problem = why; bindingEdit = e; search(); return true
        }
        bindingEdit = nil
        text = ""
        flash("\(HotkeySpec.pretty(spec)) now runs \(e.title)")
        return true
    }

    // MARK: running one

    /// A hotkey was pressed. A row that asks first (a shell line, Restart) opens the Capsule on
    /// itself instead, so nothing risky runs from one key. Anything else just runs.
    func runFromHotkey(_ row: ResultItem) {
        guard let action = row.actions.first else { return }
        if action.confirm != nil || action.needsFrontApp {
            onShow?(row.title)
            return
        }
        Task { @MainActor in
            let out = await action.run(row, ActionContext(query: Query(row.title), frontIsBack: false))
            switch out {
            case .close(let note): if let note { Notifier.shared.post(title: "Vyre", body: note) }
            case .said(let s): if !s.isEmpty { Notifier.shared.post(title: row.title, body: s) }
            case .failed(let s): Notifier.shared.post(title: row.title, body: s)
            case .replaceQuery(let s): onShow?(s)
            case .openPanel: onShow?(row.title)
            }
        }
    }
}
