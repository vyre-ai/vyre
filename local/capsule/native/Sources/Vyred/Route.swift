// Route: what the words in the Capsule mean, who `@` is completing, and where Enter will send.
// Ported from local/capsule/lib/route.js.
//
// Pure, so every rule here is tested without a window. The Capsule shows the destination before
// anything is sent (floor rule 2), which means this file decides what the user reads in the
// "Sends to" row, and the send path must use exactly the destination it returned. There is no
// second decision after Enter: the prototype had one, and the same sentence came to mean one
// thing on screen and another in the daemon.
//
// The catalog types (agents, projects, threads) live here because everything that names one of
// them reads them from here: the bridge fills them, `@` completes them, Glass and the catalog
// provider list them. Times are milliseconds since 1970, as vyred sends them.

import Foundation

// MARK: - The catalog

public struct VyreAgent: Sendable, Equatable {
    public var name: String
    public var kind: String?
    public var doing: String?
    /// The agent's current thread, if it has one.
    public var thread: String?
    /// Whether it has a computer Glass can show.
    public var computer: Bool
    public init(name: String, kind: String? = nil, doing: String? = nil, thread: String? = nil, computer: Bool = false) {
        self.name = name; self.kind = kind; self.doing = doing; self.thread = thread; self.computer = computer
    }
    public var isAssistant: Bool { kind == "assistant" }
}

public struct VyrePerson: Sendable, Equatable {
    public var name: String
    public var email: String?
    public init(name: String, email: String? = nil) { self.name = name; self.email = email }
}

public struct VyreProject: Sendable, Equatable {
    public var slug: String
    public var name: String
    public var org: String?
    public var home: String?
    public var threads: Int?
    public var last: Double?
    public var people: [VyrePerson]
    public init(slug: String, name: String, org: String? = nil, home: String? = nil, threads: Int? = nil, last: Double? = nil, people: [VyrePerson] = []) {
        self.slug = slug; self.name = name; self.org = org; self.home = home; self.threads = threads; self.last = last; self.people = people
    }
}

public struct VyreThread: Sendable, Equatable {
    public var id: String
    public var label: String
    public var cwd: String?
    public var last: Double?
    public var project: String?
    public var projectName: String?
    public var agent: String?
    public init(id: String, label: String, cwd: String? = nil, last: Double? = nil, project: String? = nil, projectName: String? = nil, agent: String? = nil) {
        self.id = id; self.label = label; self.cwd = cwd; self.last = last; self.project = project; self.projectName = projectName; self.agent = agent
    }
}

/// Everything `@` can name, plus the paired box's address for Glass. `agents` is nil when this
/// vyred has no switchboard: no agents, and nothing pretends otherwise.
public struct VyreCatalog: Sendable, Equatable {
    public var agents: [VyreAgent]?
    public var projects: [VyreProject]
    public var threads: [VyreThread]
    /// The box's https origin from link.status, or nil. Never a guess.
    public var box: String?
    public init(agents: [VyreAgent]? = nil, projects: [VyreProject] = [], threads: [VyreThread] = [], box: String? = nil) {
        self.agents = agents; self.projects = projects; self.threads = threads; self.box = box
    }
    public static let empty = VyreCatalog()

    public var assistant: VyreAgent? { agents?.first(where: \.isAssistant) }
    public func project(_ slug: String?) -> VyreProject? { slug.flatMap { s in projects.first { $0.slug == s } } }
    public func thread(_ id: String?) -> VyreThread? { id.flatMap { i in threads.first { $0.id == i } } }
}

public enum CandidateKind: String, Sendable, Equatable {
    case agent, project, thread
    /// An app or service an extension can send words to ("@Notes", "@Slack"), CapsuleExtension.mentions.
    case app
}

/// One thing `@` can name, as a row: the label is what people read, the id is never shown.
public struct VyreCandidate: Sendable, Equatable {
    public var kind: CandidateKind
    public var id: String
    public var label: String
    public var sub: String
    public var last: Double
    public init(kind: CandidateKind, id: String, label: String, sub: String = "", last: Double = 0) {
        self.kind = kind; self.id = id; self.label = label; self.sub = sub; self.last = last
    }
}

public enum DestinationKind: String, Sendable, Equatable {
    case assistant, agent, recall, thread, quick
    case newThread = "new-thread"
}

/// How a destination reads in the "Sends to" row: who, then project > thread.
public struct DestinationShow: Sendable, Equatable {
    public var who: String
    public var `where`: [String]
    public var meta: String?
    public init(who: String, where w: [String], meta: String? = nil) { self.who = who; self.where = w; self.meta = meta }
}

public struct VyreDestination: Sendable, Equatable {
    public var kind: DestinationKind
    public var agent: String?
    public var project: String?
    public var projectName: String?
    public var thread: String?
    public var threadLabel: String?
    public var cwd: String?
    public var model: String?
    public var deep: Bool
    public var meta: String
    public init(kind: DestinationKind, agent: String? = nil, project: String? = nil, projectName: String? = nil, thread: String? = nil,
                threadLabel: String? = nil, cwd: String? = nil, model: String? = nil, deep: Bool = false, meta: String = "") {
        self.kind = kind; self.agent = agent; self.project = project; self.projectName = projectName; self.thread = thread
        self.threadLabel = threadLabel; self.cwd = cwd; self.model = model; self.deep = deep; self.meta = meta
    }
    /// How it reads, so the UI draws it without a copy of the rules.
    public var show: DestinationShow { Route.describe(self) }
}

public struct MentionState: Sendable, Equatable {
    /// What follows the `@` being typed, or nil when no `@` is being typed.
    public var completing: String?
    /// Character offsets of the `@` and the caret; -1 when nothing is being completed.
    public var start: Int
    public var end: Int
}

public struct ThreadHit: Sendable, Equatable {
    public var thread: VyreThread
    public var matched: [String]
}

/// A row in the one list for a bare query, as route.js ranked it.
public struct RankRow: Sendable, Equatable {
    public var kind: String
    public var id: String
    public var label: String
    public var sub: String
    public var last: Double
    public var target: String
    public var score: Double
    public var used: Double
    public var source: String?
    public var fileKind: String?
    public var uti: String?
    public var repo: Bool
    public init(kind: String, id: String, label: String, sub: String = "", last: Double = 0, target: String = "", score: Double = 0,
                used: Double = 0, source: String? = nil, fileKind: String? = nil, uti: String? = nil, repo: Bool = false) {
        self.kind = kind; self.id = id; self.label = label; self.sub = sub; self.last = last; self.target = target; self.score = score
        self.used = used; self.source = source; self.fileKind = fileKind; self.uti = uti; self.repo = repo
    }
}

// MARK: - The rules

public enum Route {
    fileprivate static let kindOrder: [CandidateKind: Int] = [.agent: 0, .project: 1, .thread: 2, .app: 3]

    /// "4 days", "18 min". What the boards show beside a thread or a held item.
    public static func age(_ ms: Double?, now: Double = vyNowMs()) -> String {
        // No time, or one before 2001 (a zero or a test's small number): no age, never "691 months".
        guard let ms, ms >= 1_000_000_000_000 else { return "" }
        let s = max(0, ((now - ms) / 1000).rounded())
        if s < 60 { return "now" }
        let m = (s / 60).rounded()
        if m < 60 { return "\(Int(m)) min" }
        let h = (m / 60).rounded()
        if h < 24 { return "\(Int(h)) h" }
        let d = (h / 24).rounded()
        if d < 14 { return d == 1 ? "1 day" : "\(Int(d)) days" }
        let w = (d / 7).rounded()
        return w < 9 ? "\(Int(w)) weeks" : "\(Int((d / 30).rounded())) months"
    }

    /// Split what is in the box. A chosen destination is a chip, held by the UI, not text; so this
    /// only has to find an `@` being typed right now, at the start or after a space, with the caret
    /// still inside it. Offsets are in Characters.
    public static func mention(_ text: String, caret: Int? = nil) -> MentionState {
        let chars = Array(text)
        let c = min(max(caret ?? chars.count, 0), chars.count)
        var i = c
        while i > 0, !chars[i - 1].isWhitespace, chars[i - 1] != "@" { i -= 1 }
        guard i > 0, chars[i - 1] == "@" else { return MentionState(completing: nil, start: -1, end: -1) }
        let at = i - 1
        guard at == 0 || chars[at - 1].isWhitespace else { return MentionState(completing: nil, start: -1, end: -1) }
        return MentionState(completing: String(chars[i..<c]), start: at, end: c)
    }

    fileprivate static func folder(_ cwd: String?) -> String? {
        guard let cwd else { return nil }
        return cwd.split(separator: "/").last.map(String.init)
    }

    /// Everything `@` can name, as rows.
    public static func candidates(_ cat: VyreCatalog, now: Double = vyNowMs()) -> [VyreCandidate] {
        var out: [VyreCandidate] = []
        for a in cat.agents ?? [] {
            out.append(VyreCandidate(kind: .agent, id: a.name, label: a.name,
                                     sub: a.isAssistant ? "your assistant" : (a.doing.flatMap { $0.isEmpty ? nil : $0 } ?? "agent"), last: .infinity))
        }
        for p in cat.projects {
            let parts: [String?] = [p.org != nil && p.org != p.name && !(p.org ?? "").isEmpty ? p.org : nil, "\(p.threads ?? 0) threads",
                                    (p.last ?? 0) != 0 ? age(p.last, now: now) : nil]
            out.append(VyreCandidate(kind: .project, id: p.slug, label: p.name, sub: parts.compactMap { $0 }.joined(separator: " · "), last: p.last ?? 0))
        }
        for t in cat.threads {
            let parts: [String?] = [t.projectName.flatMap { $0.isEmpty ? nil : $0 } ?? folder(t.cwd), (t.last ?? 0) != 0 ? age(t.last, now: now) : nil]
            out.append(VyreCandidate(kind: .thread, id: t.id, label: t.label.isEmpty ? String(t.id.prefix(8)) : t.label,
                                     sub: parts.compactMap { $0 }.joined(separator: " · "), last: t.last ?? 0))
        }
        return out
    }

    fileprivate static func labelWords(_ s: String) -> [String] {
        s.split(whereSeparator: { !(($0.isASCII && ($0.isLetter || $0.isNumber))) }).map(String.init)
    }

    /// Rank what `@query` could mean. An empty query lists agents first, then projects and threads
    /// by recent activity, because right after `@` the likeliest wish is "the one I was just in".
    public static func complete(_ query: String, _ cat: VyreCatalog, limit: Int = 7, now: Double = vyNowMs()) -> [VyreCandidate] {
        let q = query.lowercased()
        func score(_ c: VyreCandidate) -> Int {
            if q.isEmpty { return 1 }
            let label = c.label.lowercased()
            if label == q || c.id.lowercased() == q { return 5 }
            if label.hasPrefix(q) { return 4 }
            if labelWords(label).contains(where: { $0.hasPrefix(q) }) { return 3 }
            // Several words ("comp use set"): each starts a word of the label.
            let qw = labelWords(q)
            if qw.count > 1 { let lw = labelWords(label); if qw.allSatisfy({ w in lw.contains { $0.hasPrefix(w) } }) { return 3 } }
            if c.kind == .thread && c.id.lowercased().hasPrefix(q) { return 2 }
            if label.contains(q) { return 1 }
            return 0
        }
        let scored = candidates(cat, now: now).enumerated().map { (i: $0.offset, c: $0.element, s: score($0.element)) }.filter { $0.s > 0 }
        let sorted = scored.sorted { a, b in
            if a.s != b.s { return a.s > b.s }
            let ka = kindOrder[a.c.kind]!, kb = kindOrder[b.c.kind]!
            if ka != kb { return ka < kb }
            if a.c.last != b.c.last { return a.c.last > b.c.last }
            return a.i < b.i
        }
        return sorted.prefix(limit).map(\.c)
    }

    fileprivate static let stop: Set<String> = ["the", "and", "for", "with", "that", "this", "from", "into", "what", "when", "where", "which", "who",
        "does", "did", "has", "have", "had", "can", "could", "would", "should", "our", "your", "their", "them", "they", "you",
        "are", "was", "were", "been", "being", "about", "need", "needs", "please", "make", "just", "some", "any", "all", "new", "now"]

    /// The words that carry meaning: three letters or more, lowercased, stop words out.
    public static func words(_ s: String?) -> [String] {
        let t = (s ?? "").lowercased()
        return VyRx.all("[a-z0-9][a-z0-9'-]{2,}", t, caseless: false).filter { !stop.contains($0) }
    }

    /// Two words agree when one starts with the other's first five letters: deck/decks, rebuild/rebuilding.
    fileprivate static func agree(_ a: String, _ b: String) -> Bool {
        a == b || (a.count >= 5 && b.count >= 5 && a.prefix(5) == b.prefix(5))
    }

    /// The thread whose name shares the most words with what the user typed, and which words did
    /// it. Nothing on a tie of zero: guessing a thread from no evidence would send the message
    /// somewhere the user did not choose.
    public static func bestThread(_ text: String, _ threads: [VyreThread]) -> ThreadHit? {
        let said = words(text)
        var best: ThreadHit?
        for t in threads {
            let label = words(t.label)
            let matched = said.filter { w in label.contains { agree(w, $0) } }
            if matched.isEmpty { continue }
            if best == nil || matched.count > best!.matched.count || (matched.count == best!.matched.count && (t.last ?? 0) > (best!.thread.last ?? 0)) {
                best = ThreadHit(thread: t, matched: matched)
            }
        }
        return best
    }

    /// Where Enter sends, and the alternatives down-arrow offers. `target` is the chip (or nil for
    /// the default), `agentThreads` the threads of that agent when the switchboard can list them.
    /// `quick` says the switchboard can start a thread, so a question can go straight to a model.
    public static func destinations(_ target: VyreCandidate?, _ text: String, _ cat: VyreCatalog, agentThreads: [VyreThread] = [],
                                    now: Double = vyNowMs(), quick: Bool = false) -> (options: [VyreDestination], why: String?) {
        func threadDest(_ t: VyreThread, _ agent: String? = nil) -> VyreDestination {
            let a = agent ?? t.agent
            return VyreDestination(kind: .thread, agent: a.flatMap { $0.isEmpty ? nil : $0 }, project: t.project, projectName: t.projectName,
                                   thread: t.id, threadLabel: t.label, cwd: t.cwd, meta: "thread · \(age(t.last ?? 0, now: now).isEmpty ? "new" : age(t.last ?? 0, now: now))")
        }
        func why(_ hit: ThreadHit?, _ place: String?) -> String? {
            guard let hit else { return nil }
            return "\"\(hit.matched.joined(separator: " "))\" matched \(hit.thread.label)\(place.map { ", \($0)" } ?? "")."
        }
        guard let target else {
            let mine = cat.assistant.map { VyreDestination(kind: .assistant, agent: $0.name, meta: "your assistant") }
            // A question goes to a model. One about the user's own work goes to the assistant first,
            // which has their memory; any other goes to a fast model, which has none and answers sooner.
            if quick && asksQuestion(text) {
                let fast = VyreDestination(kind: .quick, model: "haiku", meta: "fast model · haiku")
                let deep = VyreDestination(kind: .quick, model: "sonnet", deep: true, meta: "deeper · sonnet")
                guard let mine else { return ([fast, deep], nil) }
                if let own = ownThings(text, cat) { return ([mine, fast, deep], "\(own), so \(mine.agent ?? "") answers with your memory.") }
                return ([fast, mine, deep], nil)
            }
            if let mine { return ([mine], nil) }
            // No switchboard yet, or no assistant made: memory still answers, on this Mac, with no model.
            return ([VyreDestination(kind: .recall, meta: "memory · no model")], nil)
        }
        switch target.kind {
        case .agent:
            let hit = bestThread(text, agentThreads)
            let current = VyreDestination(kind: .agent, agent: target.id, meta: "its current thread")
            guard let hit else { return ([current], nil) }
            // agents.ask always goes to the agent's current thread; there is no asking for a new one.
            // So the other choice is that current thread, unless the words already matched it.
            let currentId = cat.agents?.first { $0.name == target.id }?.thread
            var options = [threadDest(hit.thread, target.id)]
            if hit.thread.id != currentId { var c = current; c.meta = ""; options.append(c) }
            return (options, why(hit, "where \(target.id) works on it"))
        case .project:
            let p = cat.project(target.id)
            let inIt = cat.threads.filter { $0.project == target.id }.sorted { ($0.last ?? 0) > ($1.last ?? 0) }
            let fresh = VyreDestination(kind: .newThread, project: target.id, projectName: p?.name ?? target.label, cwd: p?.home)
            if let hit = bestThread(text, inIt) { return ([threadDest(hit.thread), fresh], why(hit, nil)) }
            return (inIt.isEmpty ? [fresh] : [fresh, threadDest(inIt[0])], nil)
        case .thread:
            let t = cat.thread(target.id) ?? VyreThread(id: target.id, label: target.label)
            var options = [threadDest(t)]
            if let slug = t.project, !slug.isEmpty {
                let p = cat.project(slug)
                options.append(VyreDestination(kind: .newThread, project: slug, projectName: p?.name ?? t.projectName, cwd: p?.home))
            }
            return (options, nil)
        case .app:
            // An extension's target sends through the extension itself, not through vyred.
            return ([], nil)
        }
    }

    /// The destination as the "Sends to" row reads: who, then project > thread.
    public static func describe(_ d: VyreDestination) -> DestinationShow {
        switch d.kind {
        case .recall: return DestinationShow(who: "memory", where: [])
        case .quick: return DestinationShow(who: d.deep ? "Claude · deeper" : "Claude", where: [], meta: d.meta)
        case .assistant: return DestinationShow(who: d.agent ?? "assistant", where: [])
        case .agent: return DestinationShow(who: d.agent ?? "agent", where: ["current thread"])
        case .newThread: return DestinationShow(who: d.projectName ?? d.project ?? "project", where: ["new thread"])
        case .thread:
            let who = d.agent ?? d.projectName ?? "thread"
            return DestinationShow(who: who, where: d.agent != nil && d.projectName != nil ? [d.projectName!, d.threadLabel ?? ""] : [d.threadLabel ?? ""])
        }
    }

    // MARK: one list for a bare query

    // Ties only, after name length. A higher score always wins, so an app opened ten times a day
    // can outrank a project visited once (proposal section 4).
    fileprivate static let resultOrder: [String: Int] = ["calc": 0, "app": 1, "setting": 2, "agent": 3, "project": 4, "thread": 5, "contact": 6,
                                                         "folder": 7, "file": 8, "boxfile": 9, "define": 10]
    fileprivate static let filesCap = 4, filesNamed = 8, boxFiles = 3

    /// Local results and Vyre's own, ranked as one list. Local results arrive scored (match plus
    /// frecency); Vyre candidates are scored here the same way, and files by `taste` (name tier,
    /// kind, recent use, code repos last). A calculator answer is always first: it only exists
    /// when the box is clearly arithmetic or a conversion.
    public static func rank(_ query: String, local: [RankRow] = [], files: [RankRow] = [], box: [RankRow] = [], extra: [RankRow] = [],
                            cat: VyreCatalog? = nil, boost: (String, String) -> Double = { _, _ in 0 }, limit: Int = 8,
                            now: Double = vyNowMs(), home: String = NSHomeDirectory()) -> [RankRow] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if q.isEmpty { return [] }
        var all = local
        // A handful of files unless the box reads as a filename ("q3 report.pdf", "invoice pdf",
        // "notes/"), and at most three from the box, which is further away.
        func tasted(_ rows: [RankRow], _ cap: Int) -> [RankRow] {
            rows.compactMap { r -> RankRow? in
                let t = RouteTaste.taste(r, q, now: now, home: home)
                guard t > 0 else { return nil }
                var x = r; x.score = t + boost(r.id, q); return x
            }.sorted { $0.score != $1.score ? $0.score > $1.score : $0.used > $1.used }.prefix(cap).map { $0 }
        }
        all += tasted(files, RouteTaste.filenameLike(q) ? filesNamed : filesCap)
        all += tasted(box, boxFiles)
        if let cat {
            for c in candidates(cat, now: now) {
                // A thread named only by its id is not something anyone types.
                let m = Match.score(q, c.label)
                let s = m > 0 ? m + boost(c.id, q) : 0
                if s >= 0.5 { all.append(RankRow(kind: c.kind.rawValue, id: c.id, label: c.label, sub: c.sub, last: c.last.isFinite ? c.last : 0, score: s)) }
            }
        }
        all += extra
        var seen = Set<String>()
        let unique = all.enumerated().filter { seen.insert($0.element.id).inserted }
        // On a tie the shorter name wins ("Bluetooth" the pane over "Bluetooth File Exchange"), then the kind.
        return unique.sorted { a, b in
            let x = a.element, y = b.element
            if x.score != y.score { return x.score > y.score }
            if x.label.count != y.label.count { return x.label.count < y.label.count }
            let ox = resultOrder[x.kind] ?? 99, oy = resultOrder[y.kind] ?? 99
            if ox != oy { return ox < oy }
            if x.last != y.last { return x.last > y.last }
            return a.offset < b.offset
        }.prefix(limit).map(\.element)
    }

    fileprivate static let question = "^(what|whats|what's|who|whos|why|how|when|where|which|is|are|was|were|do|does|did|can|could|should|would|will|tell|explain|summarize|summarise|draft|write|find out|remind|ask|help|make|send|check|show me)\\b"

    /// Reads as a sentence for someone, not a name to open.
    public static func questionLike(_ text: String) -> Bool {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty { return false }
        if VyRx.test("\\?\\s*$", t) { return true }
        if VyRx.test(question, t) { return true }
        return t.split(whereSeparator: \.isWhitespace).count >= 5
    }

    fileprivate static let work = "projects?|threads?|clients?|customers?|emails?|mail|inbox|messages?|meetings?|calls?|calendar|schedule|tasks?|todos?|to-dos?|repos?|"
        + "invoices?|deadlines?|notes?|files?|docs?|documents?|decks?|reports?|drafts?|agents?|team|contacts?|week|day|today|tomorrow|yesterday|work|leads?"
    fileprivate static let mine = "\\b(my|our)\\s+(\\S+\\s+){0,2}(\(work))\\b"
    fileprivate static let me = "\\b(i|me|we|us)\\b"
    fileprivate static let noun = "\\b(\(work))\\b"
    // Questions that can only be about the user's own record, whatever nouns they use.
    fileprivate static let theirs = "\\b(what did (i|we)|did (i|we)|have (i|we)|remind me|what's left|what is left|who (emailed|called|wrote|messaged) me|where did (i|we))\\b"

    fileprivate static func wordIn(_ text: String, _ name: String?) -> Bool {
        let n = (name ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if n.count < 3 { return false }
        return VyRx.test("(^|[^a-z0-9])\(NSRegularExpression.escapedPattern(for: n))('s)?([^a-z0-9]|$)", text)
    }

    /// Whether a question is about the user's own things, and what said so: it names one of their
    /// projects, threads, agents or people, says my/our (or I/me) with a work noun, or asks about
    /// what they did. Nil when it reads as a general question.
    public static func ownThings(_ text: String, _ cat: VyreCatalog) -> String? {
        for p in cat.projects {
            if wordIn(text, p.name) || wordIn(text, p.slug) { return "it names \(p.name)" }
            for person in p.people {
                let first = person.name.split(whereSeparator: \.isWhitespace).first.map(String.init) ?? person.name
                if wordIn(text, person.name) || wordIn(text, first) { return "\(first) is in \(p.name)" }
            }
        }
        for a in cat.agents ?? [] where wordIn(text, a.name) { return "it names \(a.name)" }
        // A thread is named only by its whole label: one shared word ("planning") is not naming it.
        for th in cat.threads where !th.label.isEmpty && !words(th.label).isEmpty && wordIn(text, th.label) { return "it names \(th.label)" }
        if VyRx.test(mine, text) || (VyRx.test(me, text) && VyRx.test(noun, text)) || VyRx.test(theirs, text) { return "it asks about your own work" }
        return nil
    }

    fileprivate static let asks = "^(what|whats|what's|who|whos|who's|why|how|hows|how's|when|where|which|is|are|was|were|do|does|did|can|could|should|would|will|explain|tell me|define)\\b"

    /// A question for a model, narrower than questionLike: a sentence ending in "?" or opening with
    /// a question word. A command ("send the invoice", "draft a reply") is work for the assistant,
    /// which can act, so it keeps going there even though it reads as a sentence.
    public static func asksQuestion(_ text: String) -> Bool {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return !t.isEmpty && (VyRx.test("\\?\\s*$", t) || VyRx.test(asks, t))
    }

    public enum Intent: String, Sendable { case open, ask }

    /// What Enter does with a bare query: open the top result, or send the words on. Only a strong
    /// local match (a prefix or better, or a calculation) on something that does not read as a
    /// question opens; everything else goes to the destination the "Sends to" row shows, so a
    /// sentence never quietly becomes a file search and a name never quietly leaves the Mac.
    public static func intent(_ text: String, topKind: String?, topScore: Double) -> Intent {
        guard let kind = topKind else { return .ask }
        // A sum, and the rows that exist only because the words named them ("watch the intake
        // thread", "tell the site thread to run the tests"), are what the user meant even when it
        // reads as a sentence.
        if kind == "calc" || kind == "drive" || kind == "watch" { return .open }
        if questionLike(text) { return .ask }
        return topScore >= 0.8 ? .open : .ask
    }

    public static func intent(_ text: String, _ results: [RankRow]) -> Intent {
        intent(text, topKind: results.first?.kind, topScore: results.first?.score ?? 0)
    }
}

// MARK: - File taste (local.js taste and filenameLike, which rank needs)

enum RouteTaste {
    static let docExt: Set<String> = ["pdf", "doc", "docx", "pages", "rtf", "txt", "md", "odt", "key", "ppt", "pptx", "numbers", "xls", "xlsx",
        "csv", "tsv", "png", "jpg", "jpeg", "heic", "gif", "tif", "tiff", "webp", "svg", "psd", "ai", "sketch", "fig", "mov", "mp4",
        "m4a", "mp3", "wav", "epub", "eml", "zip", "dmg", "vcf", "ics"]
    static let codeExt: Set<String> = ["js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cc", "cpp",
        "hpp", "m", "cs", "php", "sh", "zsh", "json", "yaml", "yml", "toml", "lock", "xml", "html", "css", "scss", "sql", "map", "d", "plist"]
    static let fileExt: [String] = (Array(docExt) + Array(codeExt)).filter { $0.count >= 2 }
    static let docUti = "^(com\\.adobe\\.pdf|public\\.(image|jpeg|png|heic|tiff|movie|audio|mpeg-4|plain-text|rtf|comma-separated-values-text|presentation|spreadsheet)|com\\.apple\\.(iwork|keynote|pages|numbers)|org\\.openxmlformats|com\\.microsoft\\.(word|excel|powerpoint)|net\\.daringfireball\\.markdown)"

    static func extOf(_ name: String) -> String {
        VyRx.first("\\.([a-z0-9]{1,8})$", name, group: 1)?.lowercased() ?? ""
    }

    /// Does the box read as a filename: an extension, a slash, or a known extension as the last word?
    static func filenameLike(_ query: String) -> Bool {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if q.contains("/") { return true }
        if let dot = VyRx.first("\\.([a-z0-9]{1,5})$", q, group: 1, caseless: false), fileExt.contains(where: { $0.hasPrefix(dot) }) { return true }
        if let last = VyRx.first("\\s([a-z0-9]{2,5})$", q, group: 1, caseless: false) { return fileExt.contains(last) }
        return false
    }

    /// How much a launcher user wants this file row, or 0 to drop it. Scaled so a file never beats
    /// an app matched as well by name: "calcu" is the Calculator before Calculations.xlsx.
    static func taste(_ r: RankRow, _ query: String, now: Double, home: String) -> Double {
        let ext = extOf(r.label)
        let stem = ext.isEmpty ? r.label : String(r.label.dropLast(ext.count + 1))
        var m = max(Match.score(query, r.label), Match.score(query, stem))
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if let typed = VyRx.groups("^(.*\\S)\\s+([a-z0-9]{2,5})$", trimmed), !ext.isEmpty, typed[2].lowercased() == ext {
            m = max(m, Match.score(typed[1], stem))
        }
        if m < 0.5 { return 0 }
        var s = m >= 0.8 ? m * 0.85 : m * 0.5
        let p = r.target
        let dir = p.isEmpty ? "" : (p as NSString).deletingLastPathComponent
        let isFolder = r.kind == "folder" || r.fileKind == "folder" || r.fileKind == "dir"
        let repo = r.repo || VyRx.test("/(src|lib|app|components)/", p, caseless: false)
        if repo { s -= 0.3 }
        else if isFolder { if [home + "/Documents", home + "/Desktop", home + "/Downloads", home].contains(dir) { s += 0.05 } }
        else if VyRx.test(docUti, r.uti ?? "", caseless: false) || docExt.contains(ext) { s += 0.05 }
        else if codeExt.contains(ext) { s -= 0.1 }
        let ageMs = now - r.used
        let day = 86_400_000.0
        if r.used != 0 { s += ageMs < day ? 0.05 : ageMs < 7 * day ? 0.04 : ageMs < 30 * day ? 0.025 : ageMs < 365 * day ? 0.01 : 0 }
        else if r.last != 0 && now - r.last < 7 * day { s += 0.01 }
        return s > 0 ? s : 0
    }
}

// MARK: - Regex, cached

/// The JS regexes, compiled once. Case-insensitive by default, as most of route.js's are.
enum VyRx {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var cache: [String: NSRegularExpression] = [:]

    static func rx(_ pattern: String, caseless: Bool = true) -> NSRegularExpression? {
        let key = (caseless ? "i:" : "c:") + pattern
        lock.lock(); defer { lock.unlock() }
        if let r = cache[key] { return r }
        let r = try? NSRegularExpression(pattern: pattern, options: caseless ? [.caseInsensitive] : [])
        if let r, cache.count < 512 { cache[key] = r }
        return r
    }

    static func test(_ pattern: String, _ s: String, caseless: Bool = true) -> Bool {
        guard let r = rx(pattern, caseless: caseless) else { return false }
        return r.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }

    static func all(_ pattern: String, _ s: String, caseless: Bool = true) -> [String] {
        guard let r = rx(pattern, caseless: caseless) else { return [] }
        return r.matches(in: s, range: NSRange(s.startIndex..., in: s)).compactMap { Range($0.range, in: s).map { String(s[$0]) } }
    }

    /// Every group of the first match ("" for a group that did not take part), or nil.
    static func groups(_ pattern: String, _ s: String, caseless: Bool = true) -> [String]? {
        guard let r = rx(pattern, caseless: caseless), let m = r.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) else { return nil }
        return (0..<m.numberOfRanges).map { i in Range(m.range(at: i), in: s).map { String(s[$0]) } ?? "" }
    }

    static func first(_ pattern: String, _ s: String, group: Int = 0, caseless: Bool = true) -> String? {
        guard let g = groups(pattern, s, caseless: caseless), group < g.count else { return nil }
        return g[group]
    }
}
