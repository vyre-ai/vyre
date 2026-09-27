import Foundation
import LocalAuthentication

/// One row of Now's "Needs you": a held draft, a permission ask or a question, read the same way
/// (phone.md section 4). Pure, so its words are tested.
enum NeedItem: Identifiable, Equatable {
    case held(HeldDraft)
    case ask(AskItem)
    case question(AskItem)

    /// A threads.asks item as its row: a question or a permission.
    static func of(_ a: AskItem) -> NeedItem { a.isQuestion ? .question(a) : .ask(a) }

    var id: String {
        switch self {
        case .held(let d): "h-" + d.id
        case .ask(let a): "a-" + a.id
        case .question(let a): "q-" + a.id
        }
    }
    var at: Double {
        switch self {
        case .held(let d): d.at
        case .ask(let a), .question(let a): a.at
        }
    }
    var agent: String? {
        switch self {
        case .held(let d): d.agent
        case .ask(let a), .question(let a): a.agent
        }
    }
    var project: String? {
        switch self {
        case .held(let d): d.project
        case .ask(let a), .question(let a): a.project
        }
    }
    var anchor: Anchor {
        switch self {
        case .held(let d): d.anchor
        case .ask(let a), .question(let a): a.anchor
        }
    }
    var presence: PresenceHint? {
        switch self {
        case .held(let d): d.presence
        case .ask(let a), .question(let a): a.presence
        }
    }
    /// Show the Face ID glyph and "with Face ID": only when the box says a proof is needed and no
    /// session covers it. Never guessed from the tool.
    var faceID: Bool { presence?.faceID ?? false }
    var isDraft: Bool { if case .held = self { return true }; return false }
    var isQuestion: Bool { if case .question = self { return true }; return false }

    /// The swipe-right verb: "Send" for a draft that sends, "Answer" for a question, else "Approve".
    var approveVerb: String {
        switch self {
        case .held(let d): d.kind == "send" ? "Send" : "Approve"
        case .question: "Answer"
        case .ask: "Approve"
        }
    }
    /// The swipe-left verb: "Discard" for a draft, "Later" for a question, "Deny" for an ask.
    var denyVerb: String {
        switch self {
        case .held: "Discard"
        case .question: "Later"
        case .ask: "Deny"
        }
    }
    /// Swiping right commits at once only for an ask. A draft first shows its final words (the
    /// sheet), and a question has no one-swipe answer.
    var swipeOpensSheet: Bool { !(self.isAsk) }
    var isAsk: Bool { if case .ask = self { return true }; return false }

    /// Line 1. An ask is its action ("Push q3-report"); a draft is the verb and the person
    /// ("Send email to Dana"); a question is "<agent> has a question".
    var title: String {
        switch self {
        case .held(let d): NeedItem.draftTitle(d)
        case .ask(let a): NeedItem.askTitle(tool: a.tool, summary: a.summary, destination: a.destination)
        case .question(let a): "\(a.agent ?? "Vyre") has a question"
        }
    }

    /// Line 2: the command for an ask (mono), the subject for a draft, the question.
    var line2: String {
        switch self {
        case .held(let d):
            let subject = d.fields.first { $0.key == "subject" }?.value
            let body = d.fields.first { $0.key == "body" }?.value.split(separator: "\n").first.map(String.init)
            return subject ?? body ?? d.summary
        case .ask(let a): return a.summary
        case .question(let a): return a.questions.first?.question ?? a.summary
        }
    }
    var line2IsCommand: Bool { isAsk }

    /// Line 3: "<agent> · <project>".
    var line3: String { [agent, project].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ") }

    /// What VoiceOver reads (phone.md section 12): "kit, Harlow Legal, wants to push q3-report,
    /// git push origin q3-report, 4 minutes ago."
    func spoken(now: Date = Date()) -> String {
        let who = [agent, project].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", ")
        let what = title.prefix(1).lowercased() + title.dropFirst()
        let when = age(at, now: now)
        return [who.isEmpty ? nil : who, isQuestion ? "asks" : "wants to \(what)", line2, when.isEmpty ? nil : (when == "now" ? "just now" : "\(when) ago")]
            .compactMap { $0 }.joined(separator: ", ") + "."
    }

    static let subcommandTools: Set<String> = ["git", "npm", "pnpm", "yarn", "docker", "kubectl", "cargo", "swift", "make", "gh", "brew", "vyre"]

    static func askTitle(tool: String, summary: String, destination: String?) -> String {
        func base(_ p: String?) -> String { (p ?? "").split(separator: "/").last.map(String.init) ?? "" }
        switch tool {
        case "Bash":
            let words = summary.split(whereSeparator: { $0.isWhitespace }).map(String.init)
            guard let first = words.first else { return "Run a command" }
            if subcommandTools.contains(first), words.count >= 2 {
                let verb = words[1].prefix(1).uppercased() + words[1].dropFirst()
                let target = words.count > 2 ? words.last.map { " " + $0 } ?? "" : ""
                return verb + target
            }
            return "Run " + first
        case "Write": return "Write " + base(destination ?? summary.split(separator: " ").last.map(String.init))
        case "Edit", "MultiEdit", "NotebookEdit": return "Edit " + base(destination ?? summary.split(separator: " ").last.map(String.init))
        case "Read": return "Read " + base(destination ?? summary.split(separator: " ").last.map(String.init))
        case "WebFetch":
            let url = summary.replacingOccurrences(of: "fetch ", with: "")
            return "Fetch " + (URL(string: url)?.host ?? url)
        default: return "Use " + tool
        }
    }

    static func draftTitle(_ d: HeldDraft) -> String {
        let to = d.fields.first { $0.key == "to" }?.original ?? ""
        let isMail = d.via.contains("mail") || d.fields.contains { $0.key == "subject" }
        if d.kind == "send" && isMail && !to.isEmpty { return "Send email to " + person(to) }
        return d.title
    }

    /// "Dana" from "dana@harlowlegal.com" or "Dana <dana@harlowlegal.com>"; the first of several.
    static func person(_ to: String) -> String {
        let first = to.split(separator: ",").first.map { $0.trimmingCharacters(in: .whitespaces) } ?? to
        if let lt = first.firstIndex(of: "<") {
            let name = first[..<lt].trimmingCharacters(in: .whitespaces)
            if !name.isEmpty { return String(name.split(separator: " ").first ?? Substring(name)) }
        }
        let local = first.split(separator: "@").first.map(String.init) ?? first
        let word = local.split(whereSeparator: { $0 == "." || $0 == "_" || $0 == "-" }).first.map(String.init) ?? local
        return word.prefix(1).uppercased() + word.dropFirst()
    }
}

/// How this phone proves presence, in words and a glyph: Face ID, Touch ID, or the passcode.
enum Biometry {
    static var kind: LABiometryType {
        let c = LAContext()
        _ = c.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        return c.biometryType
    }
    /// "Face ID", "Touch ID", "passcode".
    static var name: String {
        switch kind {
        case .faceID: "Face ID"
        case .touchID: "Touch ID"
        case .opticID: "Optic ID"
        default: "passcode"
        }
    }
    static var glyph: String {
        switch kind {
        case .faceID: "faceid"
        case .touchID: "touchid"
        case .opticID: "opticid"
        default: "lock"
        }
    }
}
