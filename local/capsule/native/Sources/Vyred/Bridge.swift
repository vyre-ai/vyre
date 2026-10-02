// Bridge: the words and shapes VyreModel hands the UI, and the pure parts of lib/bridge.js.
//
// The window never talks to vyred. It asks VyreModel, and VyreModel asks vyred's API over the
// socket: the same tools the CLI, the Deck and Claude use (spec 9, "none reads the store
// directly"). There is one copy of what is true (the waiting list, the reply streaming in) that
// any view, shown or re-shown, is handed whole.
//
// The switchboard (core/switchboard, module `threads`, and core/agents) and the Gate (gate.*) are
// optional modules. Which of their tools exist is read from GET /v1/tools, and every feature that
// needs a missing one says so in words, rather than failing a call and showing nothing.

import Foundation

public enum Bridge {
    static let missing = [
        "agents": "The assistant and agents come with the switchboard, which this Vyre is not running yet.",
        "threads": "Driving a session needs the switchboard, which this Vyre is not running yet.",
        "gate": "Holds come from the Gate, which this Vyre is not running yet.",
    ]

    /// Words for an error, for the one line the Capsule shows.
    public static func explain(code: String, message: String) -> String {
        if code == "unreachable" { return "Vyre is not running. Start Vyre: Return on an empty Lumen." }
        if code == "presence" { return message }
        if code == "no_such_tool" {
            if let mod = VyRx.first("no tool (\\w+)\\.", message, group: 1, caseless: false), let words = missing[mod] { return words }
            return message
        }
        if code == "denied" { return "The rules stopped it: \(message)" }
        // The box runs at most so many sessions at once (ADR 0030): threads.start says busy.
        if code == "busy" { return message.isEmpty ? "Your server is running as many sessions as it allows. Stop one, or try again when one finishes." : message }
        // threads.send knows every session Vyre started, idle ones included (they resume); only a
        // session started in a terminal is not one.
        if message.hasPrefix("no thread ") { return "That session runs in a terminal, not in Vyre, so it cannot be typed into from here. Open it in its terminal, or start a new thread." }
        return message.isEmpty ? code : message
    }

    public static func explain(_ r: VyredResult) -> String? {
        if case .failure(let code, let message) = r { return explain(code: code, message: message) }
        return nil
    }

    /// The words a quick question is sent with: the user's own, then how to answer.

    /// The tool a destination needs.
    static func needs(_ d: VyreDestination) -> String? {
        switch d.kind {
        case .assistant, .agent: return "agents.ask"
        case .newThread, .quick: return "threads.start"
        case .thread: return "threads.send"
        case .recall: return nil
        }
    }

    /// Why accepting or declining a lesson, or sending a held draft, did not happen, in words.
    /// These are meant to need presence, a signed proof that a person clicked (ADR 0004); a
    /// refusal for want of it says where the click can be made instead.
    static func presenceRefused(code: String, message: String, lesson: Bool, yes: Bool, id: String) -> String? {
        guard code == "presence" || VyRx.test("presence|signed|passkey|person", message) else { return nil }
        if lesson {
            return "Vyre needs proof that a person \(yes ? "accepted" : "declined") this, which Lumen cannot give yet. Do it in the Deck, or with vyre learn \(yes ? "accept" : "retire") \(id). It is still waiting."
        }
        // The Capsule asked and the person said no, or it could not ask: its own words.
        if code == "presence" { return "\(message) It is still held." }
        return "Vyre needs proof that a person \(yes ? "approved" : "discarded") this, and it refused Lumen's. Do it in the Deck. It is still held."
    }

    /// vyred's home from its socket, when the socket sits in it (<home>/vyred.sock).
    static func homeOf(_ socket: String) -> String? {
        (socket as NSString).lastPathComponent == "vyred.sock" ? (socket as NSString).deletingLastPathComponent : nil
    }

    static func folderOf(_ cwd: String?) -> String? { cwd.flatMap { $0.split(separator: "/").last.map(String.init) } }

    /// Recall marks matches with guillemets; the Capsule shows plain words.
    static func plain(_ s: String) -> String { s.replacingOccurrences(of: "«", with: "").replacingOccurrences(of: "»", with: "") }

    /// A fact's confidence as 0..1, or nil when memory gave none.
    static func confidenceOf(_ x: [String: Any]) -> Double? {
        guard let c = VJ.num(x["confidence"]), c.isFinite else { return nil }
        return max(0, min(1, c))
    }
}

// MARK: - What the UI is handed

public struct VyreCapabilities: Sendable, Equatable {
    public var agents = false, threads = false, gate = false, recall = false, quick = false, stop = false
    public init() {}
}

public struct RefreshOutcome: Sendable, Equatable {
    public var up: Bool
    public var why: String?
}

public struct MentionResult: Sendable, Equatable {
    public var state: MentionState
    public var items: [VyreCandidate]
}

public struct DestinationChoice: Sendable, Equatable {
    public var options: [VyreDestination]
    public var why: String?
    /// Said up front when the first option cannot be reached from this vyred, not after Enter.
    public var unavailable: String?
}

public struct RecallAnswer: Sendable, Equatable {
    public var ms: Double
    public var answer: String?
    public var confidence: Double?
    public var answerAge: String?
    public var more: [String]
    public var sources: [RecallSource]
    public var error: String?
}

public struct SourceTurn: Sendable, Equatable {
    public var seq: Int?
    public var role: String
    public var text: String
    public var age: String
}

public struct SourceView: Sendable, Equatable {
    public var name: String
    public var cwd: String?
    public var seq: Int?
    public var turns: [SourceTurn]
}

public struct SendOutcome: Sendable, Equatable {
    public var thread: String?
    public var error: String?
    /// Who has the keyboard, when that is why it was not sent. Taking it is the user's call.
    public var holder: String?
    public static func sent(_ t: String) -> SendOutcome { SendOutcome(thread: t) }
    public static func failed(_ e: String, holder: String? = nil) -> SendOutcome { SendOutcome(error: e, holder: holder) }
}

public struct CancelOutcome: Sendable, Equatable {
    public var ok: Bool
    public var stopped: Bool
    public var note: String?
}

public struct MailDraft: Sendable, Equatable {
    public var to: String
    public var subject: String
    public var body: String
}

/// What the user changed in a held draft before Send.
public struct DraftEdit: Sendable, Equatable {
    public var to: [String]?
    public var subject: String?
    public var body: String?
    public init(to: [String]? = nil, subject: String? = nil, body: String? = nil) { self.to = to; self.subject = subject; self.body = body }
    var json: [String: Any] {
        var d: [String: Any] = [:]
        if let to { d["to"] = to }
        if let subject { d["subject"] = subject }
        if let body { d["body"] = body }
        return d
    }
}

/// A hold's words, for the card. Mail reads as To, Subject and a body, each editable. Anything
/// else (an http call) is shown as the Gate summarised it and approved as it is.
public struct HeldCard: Sendable, Equatable {
    public var id: String
    public var draft: MailDraft?
    public var summary: String
    public var via: String?
    public var kind: String?
    public var error: String?
}

/// The hold card that is open, repainted when another surface revises it.
public struct HeldCardState: Sendable, Equatable {
    public var card: HeldCard
    /// Bumped each time the words were read again after a gate.revised.
    public var revision: Int
    /// Who revised it last, when someone did ("deck", "chat").
    public var revisedBy: String?
    /// It left the Gate (sent, rejected) while open.
    public var gone: Bool
}

public enum AnswerDecision: String, Sendable {
    case allow, deny, send, discard, accept, decline
}

public struct ReplyView: Sendable, Equatable {
    public var thread: String
    public var text: String
    public var tools: [ReplyTool]
    public var finished: Bool
    public var ok: Bool?
    public var error: String?
    public var lease: String?
    public var model: String?
    public var cost: Double?
    public var ms: Double?
    public var memory: ReplyMemory?

    init(_ r: Reply) {
        thread = r.thread; text = VyState.replyText(r); tools = r.tools; finished = r.finished; ok = r.ok; error = r.error
        lease = r.lease; model = r.model; cost = r.cost; ms = r.ms; memory = r.memory
    }
}
