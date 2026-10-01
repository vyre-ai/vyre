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
        s.onLocked = { [weak self] retry in self?.offerVaultUnlock(retry: retry) }
        s.onNeed = { [weak self, weak s] need in self?.askCredential(need) { s?.reload() } }
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

extension CapsuleModel {
    /// The one line under the empty box: the next meeting, from the Calendar command a module declares
    /// (a first-party command with the id "next"). Asked when Lumen shows, at most once a minute; a vyred
    /// with no such command, or no meeting, shows no line.
    func loadNextMeeting() {
        guard let p = viewProvider, vyred.has("capsule.view") else { nextMeeting = nil; return }
        if let at = nextMeetingAt, Date().timeIntervalSince(at) < 60 { return }
        nextMeetingAt = Date()
        Task { @MainActor [vyred] in
            if p.commands.isEmpty { await p.readNow() }
            guard let c = p.commands.first(where: { $0.id == "next" && $0.firstParty }) else { self.nextMeeting = nil; return }
            let r = await vyred.call("capsule.view", ["module": c.module, "command": c.id, "view": "list"], presence: false)
            guard case .list(let l) = ViewFrame.parse(r.data), let row = l.rows.first else { self.nextMeeting = nil; return }
            self.nextMeeting = [row.title, row.subtitle, row.accessory].compactMap { $0 }.joined(separator: " \u{00B7} ")
        }
    }
}

extension CapsuleModel {
    /// The vault said "locked". Show one row, "Unlock the vault on this Mac"; Return asks for the person's
    /// proof through vault.account.unlock (Touch ID, or the vault password where this Mac has no reader),
    /// then repeats what failed. It never unlocks ahead of time, and a live presence session covers the
    /// proof, so a person already proven at the Mac is not asked twice.
    func offerVaultUnlock(retry: @escaping @MainActor () async -> ActionOutcome?) {
        let touch = biometricsAvailable()
        let row = ResultItem(id: "vault-unlock", kind: "unlock", title: "Unlock the vault on this Mac",
                             subtitle: touch ? "Touch ID, then it carries on" : "Your vault password, then it carries on",
                             icon: .symbol("lock.open"), section: .top, score: 1,
                             actions: [ResultAction(id: "unlock", title: "Unlock", symbol: touch ? "touchid" : "key") { [weak self] _, _ in
                                 guard let self else { return .failed("Not now.") }
                                 if !touch {
                                     await MainActor.run { self.vaultPassword = VaultPasswordAsk(retry: retry) }
                                     return .said("")
                                 }
                                 if let why = await self.unlocker(nil) { return .failed(why) }
                                 await MainActor.run { self.groups = []; self.line = nil }
                                 if let out = await retry() { return out }
                                 return .said("Unlocked.")
                             }])
        groups = [Group(section: .top, items: [row])]
        selected = 0
        line = nil
    }

    /// Send the password typed in the card, then clear it. The field is emptied before the call returns, whatever happened.
    func submitVaultPassword() async {
        guard let ask = vaultPassword, !ask.password.isEmpty, !ask.busy else { return }
        let pw = ask.password
        ask.password = ""
        ask.busy = true; ask.error = nil
        let why = await unlocker(pw)
        ask.busy = false
        if let why { ask.error = why; return }
        vaultPassword = nil
        groups = []; line = nil
        if let out = await ask.retry() { handle(out) } else { flash("Unlocked") }
    }

    func cancelVaultPassword() { vaultPassword?.password = ""; vaultPassword = nil }
}

/// The vault password, typed in the panel on a Mac with no Touch ID reader. Lives only in the field and the one call.
@MainActor final class VaultPasswordAsk: ObservableObject, Identifiable {
    @Published var password = ""
    @Published var busy = false
    @Published var error: String?
    let retry: @MainActor () async -> ActionOutcome?
    init(retry: @escaping @MainActor () async -> ActionOutcome?) { self.retry = retry }
}

/// vault.account.unlock as the person: Touch ID (with their presence proof), or the vault password where there is
/// no reader (the password is the proof). Nil on success, else the words.
@MainActor
func unlockVaultAccount(_ vyred: VyredClient, password: String?) async -> String? {
    // Touch ID is the person's presence proof. The vault password is its own proof: no separate proof is
    // sent with it, so the person is asked once, not twice (vault, work/vault-next b7d53689).
    var input: [String: Any] = ["method": "touchid"]
    if let password { input = ["password": password] }
    let r = await vyred.call("vault.account.unlock", input, presence: password == nil, summary: "Unlock your vault on this Mac")
    if let why = Bridge.explain(r) { return why }
    return nil
}

/// A setting an agent changed because the person asked ("Auto-approve edits changed, as you asked."), with Undo.
struct LoosenedNotice: Equatable {
    var change: String
    var label: String
    var at: Date
    var words: String { "\(label) changed, as you asked." }
}

extension CapsuleModel {
    /// settings.loosened { change, key, label, ... }: show the fixed words and Undo until it is undone, dismissed or old.
    func noticeLoosened(_ payload: [String: Any]) {
        guard let change = VJ.nonEmpty(payload["change"]) else { return }
        let label = VJ.nonEmpty(payload["label"]) ?? VJ.nonEmpty(payload["key"]) ?? "A setting"
        let n = LoosenedNotice(change: change, label: label, at: Date())
        loosened = n
        if !isShown() { Notifier.shared.post(title: "Lumen", body: n.words) }
        objectWillChange.send()
    }

    /// Undo needs no proof: settings.undo {change}.
    func undoLoosened() async {
        guard let n = loosened else { return }
        let r = await vyred.call("settings.undo", ["change": n.change], presence: false)
        if let why = Bridge.explain(r) { line = why; return }
        loosened = nil
        flash("\(n.label) is back as it was")
    }

    var loosenedShown: Bool { text.isEmpty && loosened.map { Date().timeIntervalSince($0.at) < 600 } == true }
}
