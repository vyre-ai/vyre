import Foundation
import Observation

/// One editable field of a held item, as deck/js/editable.js lays them out.
struct HeldField: Identifiable, Equatable, Sendable {
    let key: String
    let original: String
    /// Edited as pretty JSON and parsed back (anything that is not a string).
    let isJSON: Bool
    var value: String

    var id: String { key }
    var label: String {
        switch key {
        case "to": "To"
        case "cc": "Cc"
        case "bcc": "Bcc"
        case "url": "URL"
        default: key.prefix(1).uppercased() + key.dropFirst()
        }
    }
    var changed: Bool { value != original }
    var multiline: Bool { key == "body" || isJSON || original.contains("\n") }
}

/// A held tool call at the Gate, with its fields edited in place. Pure: the view binds to
/// `fields`, and `approveInput()` is what gate.approve receives.
struct HeldDraft: Equatable, Sendable, Identifiable {
    let id: String
    let kind: String
    let via: String
    let summary: String
    let why: String?
    let agent: String?
    let thread: String?
    let project: String?
    let at: Double
    let state: String
    var fields: [HeldField]
    /// A send that failed and came back held.
    var error: String?
    /// Where it sits in its session (gate.get's `anchor`, on work/chat 10604b9).
    let anchor: Anchor
    /// What the box says about presence for this item, when it says (all optional).
    let presence: PresenceHint?
    /// What the draft drew from, when the box lists it: shown in a From memory block.
    let sources: [String]
    /// A held push's diff summary, when the box sends one.
    let changes: ChangeSet?

    static let order = ["subject", "cc", "bcc", "method", "url", "headers"]

    /// From `gate.get`: `Brief & {state, draft, final, error, ...}`. The content is `final ?? draft`.
    init(get g: JSON) {
        id = g["id"].text
        kind = g["kind"].string ?? "send"
        via = g["via"].text
        summary = g["summary"].text
        why = g["why"].string
        agent = g["agent"].string
        thread = g["thread"].string
        project = g["project"].string
        at = g["at"].double ?? 0
        state = g["state"].string ?? "held"
        error = g["error"].string
        anchor = Anchor(g["anchor"], thread: g["thread"].string, at: g["at"].double)
        presence = PresenceHint(g["presence"])
        sources = g["sources"].list.compactMap { $0.string ?? $0["title"].string ?? $0["name"].string }
        changes = ChangeSet(changes: g["changes"], totals: g["totals"])
        let content = g["final"].isNull ? g["draft"] : g["final"]
        var fs: [HeldField] = []
        let to = g["to"].strings.joined(separator: ", ")
        fs.append(HeldField(key: "to", original: to, isJSON: false, value: to))
        let obj = content.object ?? [:]
        let others = obj.keys.filter { !HeldDraft.order.contains($0) && $0 != "body" && $0 != "to" }.sorted()
        for k in HeldDraft.order.filter({ obj[$0] != nil }) + others + (obj["body"] != nil ? ["body"] : []) {
            let v = obj[k] ?? .null
            let (text, json) = HeldDraft.render(v)
            fs.append(HeldField(key: k, original: text, isJSON: json, value: text))
        }
        fields = fs
    }

    static func render(_ v: JSON) -> (String, Bool) {
        if let s = v.string { return (s, false) }
        if v.isNull { return ("", false) }
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        let text = (try? enc.encode(v)).map { String(decoding: $0, as: UTF8.self) } ?? ""
        return (text, true)
    }

    /// "Send" for a send, otherwise "Approve".
    var primaryLabel: String { kind == "send" ? "Send" : "Approve" }

    /// The title as the boards write it: "Email to alex", "POST api.example.com".
    var title: String {
        let to = fields.first { $0.key == "to" }?.original ?? ""
        switch kind {
        case "send" where via.contains("mail") || fields.contains { $0.key == "subject" }:
            return to.isEmpty ? summary : "Email to \(to)"
        default: return summary.isEmpty ? "\(kind.capitalized) via \(via)" : summary
        }
    }

    var hasChanges: Bool { fields.contains(where: \.changed) }

    enum EditError: Error, Equatable, LocalizedError {
        case badJSON(String)
        var errorDescription: String? { if case .badJSON(let k) = self { return "\(k) is not valid JSON." }; return nil }
    }

    /// Only the changed fields. `to` goes back as a list; JSON fields are parsed back; an emptied
    /// field is sent as "" (which deletes it). Nil when nothing changed.
    func edited() throws -> JSON? {
        var out: [String: JSON] = [:]
        for f in fields where f.changed {
            if f.key == "to" {
                out["to"] = JSON(f.value.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty })
            } else if f.isJSON && !f.value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                guard let v = try? JSON.parse(Data(f.value.utf8)) else { throw EditError.badJSON(f.label) }
                out[f.key] = v
            } else {
                out[f.key] = .string(f.value)
            }
        }
        return out.isEmpty ? nil : .object(out)
    }

    /// What Send runs: `gate.approve {id}`, and before it `gate.revise {id, edited}` when a field
    /// changed, so the box keeps the words the person sent (core/gate/index.js). Both go under one
    /// Face ID when the box asks for one.
    func sendCalls() throws -> [SignedCall] {
        var calls: [SignedCall] = []
        if let e = try edited() { calls.append(SignedCall(tool: "gate.revise", input: ["id": .string(id), "edited": e])) }
        calls.append(SignedCall(tool: "gate.approve", input: ["id": .string(id)]))
        return calls
    }

    /// "Send", "Send edited"; "Approve" for what is not a send.
    var sendLabel: String { hasChanges ? "\(primaryLabel) edited" : primaryLabel }

    /// What Face ID shows: the item's own words.
    var reason: String {
        let s = title.isEmpty ? summary : title
        return "\(primaryLabel): \(s)".prefix(120).description
    }
}

/// Where an item sits in its session (phone.md section 15): the tool call, else its event, else
/// the first transcript item at or after `at` in `thread`. Every field is optional.
struct Anchor: Equatable, Hashable, Sendable {
    var toolUseId: String?
    var event: Int?
    var thread: String?
    var at: Double?

    init(toolUseId: String? = nil, event: Int? = nil, thread: String? = nil, at: Double? = nil) {
        self.toolUseId = toolUseId; self.event = event; self.thread = thread; self.at = at
    }

    /// From `anchor: {tool_use_id, event, thread?, at?}`; the item's own thread and time fill in.
    init(_ j: JSON, thread: String?, at: Double?) {
        toolUseId = j["tool_use_id"].string.flatMap { $0.isEmpty ? nil : $0 }
        event = j["event"].int
        self.thread = j["thread"].string ?? thread
        self.at = j["at"].double ?? at
    }
}

/// What the box says about presence for an item: `presence: {required, covered}`. Absent means
/// the box did not say, and the phone neither shows Face ID nor asks for it first.
struct PresenceHint: Equatable, Sendable {
    let required: Bool
    let covered: Bool

    init(required: Bool, covered: Bool) { self.required = required; self.covered = covered }
    init?(_ j: JSON) {
        guard j.object != nil else { return nil }
        required = j["required"].bool ?? false
        covered = j["covered"].bool ?? false
    }

    /// Face ID shows, and runs first, only when the box needs a proof and no session covers it.
    var faceID: Bool { required && !covered }
}

/// One question of a question ask (Claude Code's AskUserQuestion, threads.asks kind "question").
struct AskQuestion: Equatable, Sendable, Identifiable {
    struct Option: Equatable, Sendable, Hashable { let label: String; let note: String? }
    let question: String
    let header: String?
    let multi: Bool
    let options: [Option]
    var id: String { question }

    init(question: String, header: String? = nil, multi: Bool = false, options: [Option]) {
        self.question = question; self.header = header; self.multi = multi; self.options = options
    }
    init?(_ j: JSON) {
        guard let q = j["question"].string, !q.isEmpty else { return nil }
        question = q
        header = j["header"].string
        multi = j["multiSelect"].bool ?? false
        options = j["options"].list.compactMap { o in o["label"].string.map { Option(label: $0, note: o["description"].string) } }
    }
}

/// What the person picked for one question: labels, and the typed "Something else".
struct QuestionPick: Equatable, Sendable {
    var chosen: [String] = []
    var other = false
    var text = ""

    /// A tap on a choice (`nil` is the "Something else" row). Single-select replaces; multi toggles.
    mutating func choose(_ label: String?, multi: Bool) {
        if multi {
            if let label { if let i = chosen.firstIndex(of: label) { chosen.remove(at: i) } else { chosen.append(label) } }
            else { other.toggle() }
        } else if let label { chosen = [label]; other = false }
        else { chosen = []; other = true }
    }

    /// Typing into "Something else" picks it (and, single-select, drops the choice).
    mutating func type(_ t: String, multi: Bool) {
        text = t
        if !t.isEmpty && !other { other = true; if !multi { chosen = [] } }
    }

    /// The answer as threads.answer takes it: the label, labels joined with ", " (in the
    /// question's order, the typed text last), or the typed text. "" when nothing is picked.
    func answer(_ q: AskQuestion) -> String {
        let typed = other ? text.trimmingCharacters(in: .whitespacesAndNewlines) : ""
        if q.multi {
            let order = q.options.map(\.label).filter { chosen.contains($0) }
            return (order + (typed.isEmpty ? [] : [typed])).joined(separator: ", ")
        }
        return other ? typed : (chosen.first ?? "")
    }

    /// `answers: {[question]: answer}`, or nil while any question has none.
    static func answers(_ qs: [AskQuestion], _ picks: [QuestionPick]) -> [String: String]? {
        var out: [String: String] = [:]
        for (i, q) in qs.enumerated() {
            let a = (i < picks.count ? picks[i] : QuestionPick()).answer(q)
            if a.isEmpty { return nil }
            out[q.question] = a
        }
        return qs.isEmpty ? nil : out
    }
}

/// How the person answers an ask, and the threads.answer input it sends (phone.md sections 5
/// and 15). "Approve" and "Answer" send allow; "Later" sends deny.
enum AskDecision: Equatable, Sendable {
    case allow
    case deny
    /// "Always in <project>": allow, and write the rule for the thread's project.
    case alwaysInProject
    case answers([String: String])

    func input(ask: String) -> JSON {
        var o: [String: JSON] = ["ask": .string(ask), "surface": "ios"]
        switch self {
        case .allow: o["decision"] = "allow"
        case .deny: o["decision"] = "deny"
        case .alwaysInProject: o["decision"] = "always"; o["scope"] = "project"
        case .answers(let a): o["decision"] = "allow"; o["answers"] = .object(a.mapValues(JSON.string))
        }
        return .object(o)
    }

    var allows: Bool { self != .deny }
}

/// A permission ask or a question from a session: `threads.asks`, with the agent and project
/// from the ask itself when the box sends them (work/chat), else from `threads.list`.
struct AskItem: Identifiable, Equatable, Sendable {
    let id: String
    let thread: String
    let tool: String
    let summary: String
    let destination: String?
    let reason: String?
    let at: Double
    /// "permission" or "question".
    let kind: String
    let questions: [AskQuestion]
    /// The project an "always in <project>" rule would be for; nil while there is none (yet).
    let alwaysProject: String?
    /// A permission's card detail (the command, file or change), as the box sends it.
    let detail: JSON
    let anchor: Anchor
    let presence: PresenceHint?
    var agent: String?
    var threadName: String?
    var project: String?

    init(_ j: JSON) {
        id = j["id"].text
        thread = j["thread"].text
        tool = j["tool"].text
        summary = j["summary"].text
        destination = j["destination"].string
        reason = j["reason"].string
        at = j["at"].double ?? 0
        kind = j["kind"].string == "question" ? "question" : "permission"
        questions = j["questions"].list.compactMap(AskQuestion.init)
        alwaysProject = j["always_project"].string.flatMap { $0.isEmpty ? nil : $0 }
        detail = j["detail"]
        anchor = Anchor(j["anchor"], thread: j["thread"].string, at: j["at"].double)
        presence = PresenceHint(j["presence"])
        agent = j["agent"].string
        threadName = j["thread_name"].string
        project = j["project"].string
    }

    /// Bash asks are commands: "May I run <command>".
    var isCommand: Bool { tool == "Bash" }
    var isQuestion: Bool { kind == "question" }

    /// What Face ID shows for a decision: the ask's own words.
    func faceIDReason(_ d: AskDecision) -> String {
        let verb: String
        switch d {
        case .allow: verb = "Approve"
        case .deny: verb = isQuestion ? "Later" : "Deny"
        case .alwaysInProject: verb = "Always allow in \(alwaysProject ?? "this project")"
        case .answers: verb = "Answer"
        }
        let what = isQuestion ? (questions.first?.question ?? summary) : summary
        return "\(verb): \(what)".prefix(120).description
    }
}

/// Held items and asks: what the Now screen, the badge and the inline cards read.
@MainActor
@Observable
final class NeedsStore {
    private(set) var held: [HeldDraft] = []
    private(set) var asks: [AskItem] = []
    private(set) var threads: [JSON] = []
    private(set) var loaded = false
    var problem: String?
    /// Rows denied, discarded or put off, waiting out their 4 s of Undo (row ids).
    private(set) var hidden: Set<String> = []
    /// The Undo toast on Now.
    private(set) var toast: Toast?
    /// Why an answer failed, by row id: shown under the row's third line.
    var failed: [String: String] = [:]
    @ObservationIgnored private var pending: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private var token: UUID?
    @ObservationIgnored private var refreshing = false
    @ObservationIgnored private var again = false

    var count: Int { held.count + asks.count }

    /// A Needs you item by its row id ("h-", "a-", "q-" and the box's id).
    func item(_ ref: String) -> NeedItem? {
        (held.map(NeedItem.held) + asks.map(NeedItem.of)).first { $0.id == ref }
    }

    /// A Needs you item by the box's own id (a push's `/needs/<id>`).
    func item(raw id: String) -> NeedItem? {
        if let d = held.first(where: { $0.id == id }) { return .held(d) }
        return asks.first { $0.id == id }.map(NeedItem.of)
    }

    nonisolated init() {}

    func attach(_ app: AppModel) {
        self.app = app
        app.hub.off(token)
        token = app.hub.on { [weak self] e in
            let watched: Set<String> = ["ask.raised", "ask.answered", "gate.held", "gate.released", "gate.failed", "gate.rejected",
                                        "gate.revised", "thread.started", "thread.finished", "thread.stopped"]
            if watched.contains(e.type) { Task { await self?.refresh() } }
        }
    }

    struct Toast: Equatable { let id: String; let text: String }

    func clear() { held = []; asks = []; threads = []; loaded = false; hidden = []; toast = nil; failed = [:] }

    /// Deny, Discard or Later (phone.md section 4): the row leaves at once with 4 s of Undo, then
    /// the box is told. No Face ID unless the box asks for one.
    func dismiss(_ item: NeedItem) {
        guard pending[item.id] == nil else { return }
        Haptics.warning()
        failed[item.id] = nil
        hidden.insert(item.id)
        toast = Toast(id: item.id, text: item.isDraft ? "Discarded." : item.isQuestion ? "Later." : "Denied.")
        pending[item.id] = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(4))
            guard let self, !Task.isCancelled else { return }
            if self.toast?.id == item.id { self.toast = nil }
            do {
                switch item {
                case .held(let d): try await self.discard(d)
                case .ask(let a), .question(let a): try await self.answer(a, .deny)
                }
            } catch where isCancel(error) {
            } catch {
                self.failed[item.id] = describe(error)
            }
            self.hidden.remove(item.id)
            self.pending[item.id] = nil
        }
    }

    func undo(_ id: String) {
        pending[id]?.cancel()
        pending[id] = nil
        hidden.remove(id)
        if toast?.id == id { toast = nil }
    }

    func refresh() async {
        guard let app else { return }
        if refreshing { again = true; return }
        refreshing = true
        defer { refreshing = false }
        repeat {
            again = false
            async let heldBriefs = try? app.call("gate.held")
            async let openAsks = try? app.call("threads.asks")
            async let list = try? app.call("threads.list")
            let (h, a, t) = await (heldBriefs, openAsks, list)
            if h == nil && a == nil && t == nil { problem = app.online ? "The box did not answer." : "Offline." } else { problem = nil }
            threads = t?.list ?? threads
            var drafts: [HeldDraft] = []
            for b in h?.list ?? [] {
                guard let id = b["id"].string else { continue }
                // Keep an edit in progress rather than replacing it with the box's copy.
                if let existing = held.first(where: { $0.id == id }), existing.hasChanges { drafts.append(existing); continue }
                if let g = try? await app.call("gate.get", ["id": .string(id)]) { drafts.append(HeldDraft(get: g)) }
                else { drafts.append(HeldDraft(get: b.with("draft", [:]))) }
            }
            if h != nil { held = drafts }
            if let a {
                asks = a.list.map { j in
                    var ask = AskItem(j)
                    let rec = threads.first { $0["id"].string == ask.thread }
                    ask.agent = ask.agent ?? rec?["agent"].string
                    ask.threadName = ask.threadName ?? rec?["name"].string
                    ask.project = ask.project ?? rec?["project"].string
                    return ask
                }
            }
            loaded = true
        } while again
        app.follow()
    }

    func update(_ d: HeldDraft) {
        if let i = held.firstIndex(where: { $0.id == d.id }) { held[i] = d }
    }

    /// Send: gate.revise (when a field changed) then gate.approve, under one Face ID when the box
    /// asks for one (`AppModel.present`). Returns nil when sent, or the error the box gave when the
    /// send failed and was held again.
    func approve(_ d: HeldDraft) async throws -> String? {
        guard let app else { return nil }
        let out = try await app.present(try d.sendCalls(), reason: d.reason, required: d.presence?.faceID ?? false).last ?? .null
        if out["state"].string == "failed" {
            var kept = d
            kept.error = out["error"].string ?? "It failed."
            update(kept)
            return kept.error
        }
        held.removeAll { $0.id == d.id }
        Haptics.success()
        return nil
    }

    /// Discard: gate.reject. No Face ID unless the box asks for it.
    func discard(_ d: HeldDraft) async throws {
        guard let app else { return }
        try await app.present([SignedCall(tool: "gate.reject", input: ["id": .string(d.id)])], reason: "Discard: \(d.title)".prefix(120).description)
        held.removeAll { $0.id == d.id }
    }

    /// threads.answer with the decision. Face ID only when the box asks (or the item says so).
    func answer(_ a: AskItem, _ d: AskDecision) async throws {
        guard let app else { return }
        try await app.present([SignedCall(tool: "threads.answer", input: d.input(ask: a.id))], reason: a.faceIDReason(d),
                              required: d.allows && (a.presence?.faceID ?? false))
        asks.removeAll { $0.id == a.id }
        if d.allows { Haptics.success() }
    }
}
