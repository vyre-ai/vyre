// ViewMode: the Capsule's side of module commands (ViewSession.swift): going into a command, its list
// as the results, Tab for a detail, Return for an action, Esc one level back and then out.

import AppKit
import Foundation

extension CapsuleModel {
    /// Wire the commands provider to this model. Called once by the app.
    func attach(views p: ViewCommandsProvider) {
        viewProvider = p
        p.enter = { [weak self] c, words in Task { @MainActor in self?.enterView(c, words: words) } }
        p.onChange = { [weak self] in Task { @MainActor in self?.refresh() } }
    }

    func enterView(_ c: ViewCommand, words: String = "") {
        exitView(clear: false)
        let s = ViewSession(command: c, vyred: vyred)
        s.onChange = { [weak self] in self?.redrawView() }
        s.onPush = { [weak self] id in
            guard let self, let c2 = self.viewProvider?.command(module: c.module, id: id) else { self?.line = "That command is not here."; return }
            self.enterView(c2)
        }
        s.onAsk = { [weak self] words in self?.prefill(words) }
        viewSession = s
        line = nil
        groups = []
        selected = 0
        if text != words { text = words } else { s.load(q: words) }
    }

    /// A module's `ask` effect: the words go in the box and stop there. Nothing is asked, recalled or
    /// sent from them (no quick answer, no memory lookup) until the person edits them or presses Return.
    func prefill(_ words: String) {
        exitView(clear: true)
        prefilled = words
        text = words
    }

    /// Leave the command. `clear` also empties the box.
    func exitView(clear: Bool = true) {
        guard let s = viewSession else { return }
        s.stop()
        viewSession = nil
        groups = []
        selected = 0
        if clear, !text.isEmpty { text = "" }
        line = nil
    }

    /// Esc: one level back; at the list, the words first, then out. False when not in a command.
    func viewBack() -> Bool {
        guard let s = viewSession else { return false }
        if s.back() { return true }
        if !text.isEmpty { text = ""; return true }
        exitView()
        return true
    }

    /// Tab on a row of a list: its detail.
    func viewOpenDetail() -> Bool {
        guard let s = viewSession, case .list? = s.level, let row = currentViewRow else { return false }
        s.openDetail(row)
        return true
    }

    /// The Return that submits a form or sends a previewed action.
    func viewSubmit() async {
        guard let s = viewSession else { return }
        let out: ActionOutcome
        if case .preview? = s.level { out = await s.confirmPreview() } else { out = await s.submit() }
        handle(out)
    }

    /// Return on an open detail: its first action.
    func viewRunDetailAction() -> Bool {
        guard let s = viewSession, case .detail(let d, let row)? = s.level, let a = d.actions.first else { return false }
        Task { @MainActor in handle(await s.act(a, row: row)) }
        return true
    }

    var currentViewRow: ViewRow? {
        guard let s = viewSession, let l = s.base, let id = current?.id else { return nil }
        return l.rows.first { "view:\(s.command.key):\($0.id)" == id }
    }

    /// The rows of the command's list as results, or one line saying why there are none.
    func redrawView() {
        guard let s = viewSession else { return }
        objectWillChange.send()
        guard case .list? = s.level else { return }
        let items = viewRows(s)
        groups = items.isEmpty ? [] : [Group(section: .modules, items: items)]
        selected = 0
        if items.isEmpty {
            if let p = s.problem { line = p }
            else if s.loading { line = nil }
            else if let l = s.base { line = l.empty ?? "Nothing here." }
        } else { line = s.problem }
    }

    func viewRows(_ s: ViewSession) -> [ResultItem] {
        guard let l = s.base else { return [] }
        return l.rows.map { r in
            var sub = [r.subtitle, r.accessory].compactMap { $0 }.joined(separator: " \u{00B7} ")
            if let from = l.from { sub = sub.isEmpty ? "from \(from)" : "from \(from) \u{00B7} \(sub)" }
            let actions = r.actions.map { a in
                ResultAction(id: a.id, title: a.title, symbol: a.outward ? "paperplane" : "return", shortcut: a.shortcut, confirm: a.confirm) { _, _ in
                    await s.act(a, row: r)
                }
            }
            return ResultItem(id: "view:\(s.command.key):\(r.id)", kind: "view-row", title: r.title, subtitle: sub,
                              icon: r.icon.flatMap { ViewIcon.spec($0) } ?? .symbol("circle"), section: .modules, score: 1, actions: actions)
        }
    }
}
