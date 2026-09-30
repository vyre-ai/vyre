// ViewSession: one open module command in the Capsule (the platform's view contract). It holds
// the levels the person has gone into (a list, a detail, a form, a preview), asks vyred for each
// frame once the words settle, and turns the person's choice on a row into a `capsule.act`. No
// tool name ever appears here: the Capsule sends the module, the command and the ids it was given.
//
// Rules it keeps:
//   - Nothing polls. A list is asked for when the words settle (120 ms after the last key), a
//     newer question cancels the older, and hiding the Capsule drops the session.
//   - A frame is remembered for 30 seconds by module, command, words and the declaration's hash.
//   - A send as the person is shown as a preview first; the second Return sends those exact words
//     (asked: {hash}). A change in the words previews again. A held answer says "Waiting for your
//     OK", never "sent".
//   - An added module's link opens only as https, mailto or vyre.

import AppKit
import Foundation

@MainActor
final class ViewSession: ObservableObject {
    enum Level {
        case list(ViewList)
        case detail(ViewDetail, row: ViewRow)
        case form(ViewForm)
        case preview(ViewPreview, pending: Pending)
    }

    /// What a preview's second Return repeats.
    struct Pending {
        var action: String
        var rowID: String?
        var form: String?
        var fields: [String: String]
    }

    let command: ViewCommand
    private let vyred: VyredLink
    private let clock: VyClock
    private let now: () -> Date

    @Published private(set) var stack: [Level] = []
    @Published var loading = false
    /// Said under the list: a slow call, or the words of an error, a missing connection or a hold.
    @Published var problem: String?
    @Published var values: [String: String] = [:]
    private(set) var q = ""

    /// Something on screen changed (rows, a level): the model draws again.
    var onChange: () -> Void = {}
    /// A `push`: go to another command of the same module.
    var onPush: (String) -> Void = { _ in }
    /// An `ask` effect: put these words in the box and leave the command.
    var onAsk: (String) -> Void = { _ in }
    /// Test seams: open a link, copy text. Default is the real thing.
    var openURL: (URL) -> Bool = { NSWorkspace.shared.open($0) }
    var copy: (String) -> Void = { s in
        CapsuleModel.replyBoard.clearContents()
        CapsuleModel.replyBoard.setString(s, forType: .string)
    }
    var slowAfter: TimeInterval = 1.5
    var settle: TimeInterval = 0.12

    private var timer: VyTimer?
    private var slowTimer: VyTimer?
    private var generation = 0
    private var cache: [String: (frame: ViewFrame, at: Date)] = [:]
    static let cacheSeconds: TimeInterval = 30

    init(command: ViewCommand, vyred: VyredLink, clock: VyClock = SystemClock(), now: @escaping () -> Date = { Date() }) {
        self.command = command; self.vyred = vyred; self.clock = clock; self.now = now
    }

    // MARK: what is on screen

    var level: Level? { stack.last }
    var base: ViewList? { if case .list(let l)? = stack.first { return l }; return nil }
    var isRoot: Bool { stack.count <= 1 }
    /// Detail, form and preview take the whole area; a list is drawn by the results list.
    var showsLevelView: Bool { if case .list? = level { return false }; return level != nil }
    var isFormOrPreview: Bool {
        switch level { case .form?, .preview?: return true; default: return false }
    }

    // MARK: the list

    /// Ask for the list for these words: at once the first time, after the words settle otherwise.
    func load(q words: String) {
        q = words
        timer?.cancel()
        let first = stack.isEmpty
        if let hit = cache[key(words)], now().timeIntervalSince(hit.at) < Self.cacheSeconds {
            generation += 1
            apply(hit.frame, words: words, cache: false)
            return
        }
        if first { fetchList(words) } else { timer = clock.schedule(after: settle) { [weak self] in self?.fetchList(words) } }
    }

    private func key(_ words: String) -> String { "\(command.key)|\(words)|\(command.hash)" }

    private func fetchList(_ words: String) {
        generation += 1
        let g = generation
        loading = true; problem = nil
        slowTimer?.cancel()
        slowTimer = clock.schedule(after: slowAfter) { [weak self] in
            guard let self, self.loading, g == self.generation else { return }
            self.problem = "\(self.command.title) is slow. Try again."
            self.onChange()
        }
        var input: [String: Any] = ["module": command.module, "command": command.id, "view": "list"]
        if command.takesArg { input["q"] = words }
        Task { [vyred] in
            let r = await vyred.call("capsule.view", input, presence: false)
            await MainActor.run {
                guard g == self.generation else { return }
                self.loading = false; self.slowTimer?.cancel()
                if let why = r.error { self.problem = why; self.onChange(); return }
                self.apply(ViewFrame.parse(r.data), words: words, cache: true)
            }
        }
    }

    private func apply(_ f: ViewFrame, words: String, cache store: Bool) {
        loading = false
        switch f {
        case .list:
            problem = nil
            if store { cache[key(words)] = (f, now()) }
            if case .list? = stack.first { stack[0] = .list(listOf(f)) } else { stack = [.list(listOf(f))] }
        case .detail(let d): stack.append(.detail(d, row: ViewRow(id: "", title: d.title, subtitle: nil, icon: nil, accessory: nil, group: nil, actions: d.actions)))
        case .form(let form): open(form)
        case .error(_, let m), .needs(_, let m), .held(let m): problem = m
        }
        onChange()
    }

    private func listOf(_ f: ViewFrame) -> ViewList {
        if case .list(let l) = f { return l }
        return ViewList(title: "", rows: [], more: false, empty: nil, from: nil)
    }

    private func open(_ form: ViewForm) {
        values = [:]
        for f in form.fields { if let v = f.value { values[f.name] = v } }
        stack.append(.form(form))
    }

    // MARK: going in and out

    func openDetail(_ row: ViewRow) {
        generation += 1
        let g = generation
        problem = nil; loading = true
        Task { [vyred, command] in
            let r = await vyred.call("capsule.view", ["module": command.module, "command": command.id, "view": "detail", "id": row.id, "q": self.q], presence: false)
            await MainActor.run {
                guard g == self.generation else { return }
                self.loading = false
                if let why = r.error { self.problem = why; self.onChange(); return }
                switch ViewFrame.parse(r.data) {
                case .detail(let d): self.stack.append(.detail(d, row: row))
                case .error(_, let m), .needs(_, let m), .held(let m): self.problem = m
                default: self.problem = "There is no more to show for that."
                }
                self.onChange()
            }
        }
    }

    /// One level back. False at the list, where the caller leaves the command.
    @discardableResult
    func back() -> Bool {
        guard stack.count > 1 else { return false }
        stack.removeLast()
        problem = nil
        onChange()
        return true
    }

    /// Stop everything in flight (the Capsule hid, or the command was left).
    func stop() {
        generation += 1
        timer?.cancel(); slowTimer?.cancel()
        loading = false
    }

    // MARK: acting

    /// Run an action of a row (or of an open detail).
    func act(_ a: ViewAction, row: ViewRow?) async -> ActionOutcome {
        let id = row.flatMap { $0.id.isEmpty ? nil : $0.id }
        var input: [String: Any] = ["action": a.id]
        if let id { input["id"] = id }
        return await call(input, pending: Pending(action: a.id, rowID: id, form: nil, fields: [:]))
    }

    /// Submit the form on screen.
    func submit() async -> ActionOutcome {
        guard case .form(let f)? = level else { return .failed("There is no form to send.") }
        for field in f.fields where field.required && (values[field.name] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return .failed("\(field.label) is needed.")
        }
        let fields = values
        return await call(["action": "submit", "form": f.id, "fields": fields], pending: Pending(action: "submit", rowID: nil, form: f.id, fields: fields))
    }

    /// The second Return on a preview: the same words, with the hash that names them.
    func confirmPreview() async -> ActionOutcome {
        guard case .preview(let p, let pending)? = level else { return .failed("Nothing to send.") }
        var input: [String: Any] = ["action": pending.action, "asked": ["hash": p.hash]]
        if let id = pending.rowID { input["id"] = id }
        if let form = pending.form { input["form"] = form; input["fields"] = pending.fields }
        return await call(input, pending: pending, replacing: true)
    }

    private func call(_ extra: [String: Any], pending: Pending, replacing: Bool = false) async -> ActionOutcome {
        var input: [String: Any] = ["module": command.module, "command": command.id, "q": q]
        for (k, v) in extra { input[k] = v }
        let r = await vyred.call("capsule.act", input, presence: false)
        if let why = r.error { return .failed(why) }
        switch ViewActResult.parse(r.data) {
        case .done(let said, let effect):
            if replacing { stack = Array(stack.prefix(1)) }
            return effectOutcome(said: said, effect: effect)
        case .push(let cmd):
            onPush(cmd); return .said("")
        case .view(let f):
            if case .form(let form) = f { open(form); problem = nil; onChange() }
            return .said("")
        case .preview(let p):
            if replacing, case .preview? = level { stack.removeLast() }
            stack.append(.preview(p, pending: pending)); problem = nil; onChange()
            return .said("")
        case .held(let m):
            if replacing { stack = Array(stack.prefix(1)); onChange() }
            return .said(m)
        case .needs(_, let m):
            problem = m; onChange(); return .failed(m)
        case .error(_, let m):
            return .failed(m)
        }
    }

    private func effectOutcome(said: String?, effect: ViewEffect?) -> ActionOutcome {
        switch effect {
        case .open(let s)?:
            guard let u = Self.safeLink(s) else { return .failed("That link is not one Lumen opens.") }
            return openURL(u) ? .close(said) : .failed("Nothing opened it.")
        case .copy(let s)?: copy(s); return .close(said ?? "Copied")
        case .say(let s)?: return .said(s)
        case .ask(let s)?: onAsk(s); return .said("")
        case nil: return said.map { .said($0) } ?? .close(nil)
        }
    }

    /// https, mailto and vyre links only.
    static func safeLink(_ s: String) -> URL? {
        guard let u = URL(string: s.trimmingCharacters(in: .whitespaces)), let scheme = u.scheme?.lowercased() else { return nil }
        switch scheme {
        case "https": return u.host?.isEmpty == false ? u : nil
        case "mailto", "vyre": return u
        default: return nil
        }
    }
}

