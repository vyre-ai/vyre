// MemoryBox: what memory.ask answered, for the card Ask memory shows (its sources, Wrong?, Forget). Memory answers only when asked
// for (#46); it is never shown above or instead of the assistant, and nothing here is sent with a question. The Capsule ranks nothing
// itself: its old local ranker read any first-person line in any transcript as a fact about the user, and answered "Jordan" from a test
// session (removed on 2026-09-27, the user's bug report).

import Foundation

/// What memory said about the words in the box: the distilled fact, and up to three sources.
public struct MemoryAnswer: Sendable, Equatable {
    public enum Kind: String, Sendable { case memory, said }
    public var text: String
    public var answer: String?
    public var answerKind: Kind?
    public var answerAge: String?
    public var confidence: Double?
    public var more: [String] = []
    public var sources: [MemorySource]
    public var ms: Double = 0
    public var error: String?
    /// How many conversations back the answer, when memory counts them (memory.answer); else the
    /// sessions among `sources`.
    public var conversations: Int?
    /// From memory.ask (Vyre IQ): the chip says its confidence (IQAnswer.chip).
    public var iq = false
    /// via was "corrected" (95b2b891): the answer is the person's own fix; "you corrected this",
    /// no source chips (its one source, "fix:<n>", is provenance, never a chip).
    public var corrected = false
    public var conversationCount: Int { conversations ?? Set(sources.map(\.session)).count }
    public init(text: String, answer: String? = nil, answerKind: Kind? = nil, answerAge: String? = nil, confidence: Double? = nil,
                more: [String] = [], sources: [MemorySource] = [], ms: Double = 0, error: String? = nil) {
        self.text = text; self.answer = answer; self.answerKind = answerKind; self.answerAge = answerAge; self.confidence = confidence
        self.more = more; self.sources = sources; self.ms = ms; self.error = error
    }
    public var isEmpty: Bool { answer == nil && sources.isEmpty }
    /// "From memory" with a fact, "From your sessions" with only quotes.
    public var label: String { answerKind == .memory || sources.contains { $0.kind == .fact } ? "From memory" : "From your sessions" }
}

public struct MemorySource: Sendable, Equatable {
    public enum Kind: String, Sendable { case fact, quote }
    public var kind: Kind
    /// "user" or "assistant", for a quote.
    public var role: String
    public var session: String
    public var seq: Int?
    public var name: String
    public var quote: String
    public var age: String
    public var confidence: Double?
}

/// One line of the memory box, and of what a quick question is told.
public struct MemoItem: Sendable, Equatable, Identifiable {
    public enum Kind: String, Sendable { case fact, quote }
    public var kind: Kind
    public var text: String
    public var age: String
    /// "You" or "Claude", for a quote.
    public var who: String?
    public var confidence: Double?
    /// A line made from the user's own words: shown, never sent (the quote under it is).
    public var said: Bool
    public var source: MemorySource?
    public var id: String { "\(kind.rawValue):\(source?.session ?? ""):\(text)" }
}

public enum Memo {
    /// "2 weeks ago", "just now", or "".
    public static func ago(_ age: String) -> String { age.isEmpty ? "" : age == "now" ? "just now" : "\(age) ago" }

    /// What the memory box shows, line by line: the fact first, then each source on screen.
    public static func items(_ m: MemoryAnswer?) -> [MemoItem] {
        guard let m else { return [] }
        var out: [MemoItem] = []
        let srcs = Array(m.sources.prefix(3))
        if let a = m.answer {
            let said = m.answerKind == .said
            out.append(MemoItem(kind: .fact, text: a, age: m.answerAge ?? "", who: nil, confidence: m.confidence, said: said,
                                source: said ? srcs.first { $0.kind == .quote } : srcs.first { $0.kind != .quote && $0.quote == a }))
        }
        for x in srcs {
            if x.kind == .quote {
                out.append(MemoItem(kind: .quote, text: x.quote, age: x.age, who: x.role == "assistant" ? "Claude" : "You", confidence: nil, said: false, source: x))
            } else if !x.quote.isEmpty && x.quote != m.answer {
                out.append(MemoItem(kind: .fact, text: x.quote, age: x.age, who: nil, confidence: x.confidence, said: false, source: x))
            }
        }
        return out
    }
}
