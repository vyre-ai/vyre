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

    func approveInput() throws -> JSON {
        var input: [String: JSON] = ["id": .string(id)]
        if let e = try edited() { input["edited"] = e }
        return .object(input)
    }

    /// What Face ID shows: the item's own words.
    var reason: String {
        let s = title.isEmpty ? summary : title
        return "\(primaryLabel): \(s)".prefix(120).description
    }
}

/// A permission ask from a session: `threads.asks` joined with `threads.list` for the agent.
struct AskItem: Identifiable, Equatable, Sendable {
    let id: String
    let thread: String
    let tool: String
    let summary: String
    let destination: String?
    let reason: String?
    let at: Double
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
    }

    /// Bash asks are commands: "May I run <command>".
    var isCommand: Bool { tool == "Bash" }
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
    @ObservationIgnored private weak var app: AppModel?
    @ObservationIgnored private var token: UUID?
    @ObservationIgnored private var refreshing = false
    @ObservationIgnored private var again = false

    var count: Int { held.count + asks.count }

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

    func clear() { held = []; asks = []; threads = []; loaded = false }

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
                    ask.agent = rec?["agent"].string
                    ask.threadName = rec?["name"].string
                    ask.project = rec?["project"].string
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

    /// gate.approve with only the changed fields, signed with the device key.
    /// Returns nil when sent, or the error the box gave when the send failed and was held again.
    func approve(_ d: HeldDraft) async throws -> String? {
        guard let app else { return nil }
        let input = try d.approveInput()
        let out = try await app.call("gate.approve", input, proof: .device(reason: d.reason))
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

    func discard(_ d: HeldDraft) async throws {
        guard let app else { return }
        _ = try await app.call("gate.reject", ["id": .string(d.id)], proof: .device(reason: "Discard: \(d.title)"))
        held.removeAll { $0.id == d.id }
    }

    /// threads.answer {ask, decision, surface:"ios"}, signed.
    func answer(_ a: AskItem, allow: Bool) async throws {
        guard let app else { return }
        let verb = allow ? "Allow" : "Deny"
        _ = try await app.call("threads.answer", ["ask": .string(a.id), "decision": allow ? "allow" : "deny", "surface": "ios"],
                           proof: .device(reason: "\(verb): \(a.summary)".prefix(120).description))
        asks.removeAll { $0.id == a.id }
        if allow { Haptics.success() }
    }
}
