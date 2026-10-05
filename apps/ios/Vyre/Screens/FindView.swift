import SwiftUI

/// What a Find query can run: the Deck's Find grammar (deck/views/find.js). `@agent words` asks
/// that agent (alone, it opens the agent); `@project words` starts a session there and `@session
/// words` types into one; "tell X to Y" types into a session and watches it; "watch X" waits for
/// it. Plain words ask the assistant. Pure, so the grammar is tested.
struct FindGrammar {
    let agents: [String]
    let assistant: String?
    /// Project slugs and names.
    let projects: [(slug: String, name: String)]
    /// Sessions, newest first: id and name.
    let sessions: [(id: String, name: String)]

    enum Action: Equatable {
        case ask(agent: String, text: String, assistant: Bool)
        case openAgent(String)
        case start(project: String, name: String, text: String)
        case drive(thread: String, name: String, text: String)
        case watch(thread: String, name: String)
        case fill(String)

        /// The plain-words action, as the Run card's row title.
        var label: String {
            switch self {
            case .ask(let a, _, _): "Ask \(a)"
            case .openAgent(let a): "Open \(a)"
            case .start(_, let n, _): "New session on \(n)"
            case .drive(_, let n, _): "Tell \(n), then watch it"
            case .watch(_, let n): "Watch \(n)"
            case .fill(let s): s.trimmingCharacters(in: .whitespaces)
            }
        }

        /// The command it runs, in mono under the label.
        var command: String {
            switch self {
            case .ask(let a, let t, _): "@\(a) \(t)"
            case .openAgent(let a): "@\(a)"
            case .start(let p, _, let t): "@\(p) \(t)"
            case .drive(_, let n, let t): "tell \(n) to \(t)"
            case .watch(_, let n): "watch \(n)"
            case .fill(let s): s.trimmingCharacters(in: .whitespaces)
            }
        }

        var isAssistantAsk: Bool { if case .ask(_, _, true) = self { return true }; return false }
    }

    /// Sessions whose name the words match, best first.
    func candidates(_ words: String) -> [(id: String, name: String)] {
        let w = words.lowercased().trimmingCharacters(in: .whitespaces)
        guard !w.isEmpty else { return [] }
        let exact = sessions.filter { $0.name.lowercased() == w }
        let part = sessions.filter { $0.name.lowercased().contains(w) && $0.name.lowercased() != w }
        return exact + part
    }

    static func match(_ s: String, _ pattern: String) -> [String]? {
        guard let re = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]),
              let m = re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) else { return nil }
        return (1..<m.numberOfRanges).map { i in Range(m.range(at: i), in: s).map { String(s[$0]) } ?? "" }
    }

    func actions(_ raw: String) -> [Action] {
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return [] }
        if s.hasPrefix("@") {
            let body = s.dropFirst()
            let name = String(body.prefix { !$0.isWhitespace }).lowercased()
            let rest = String(body.drop { !$0.isWhitespace }).trimmingCharacters(in: .whitespaces)
            let agentHits = agents.filter { $0.lowercased().hasPrefix(name) }
            let projectHits = projects.filter { $0.slug.lowercased().hasPrefix(name) }
            let threadHits = sessions.filter { $0.name.lowercased().hasPrefix(name) }
            if rest.isEmpty {
                if let a = agentHits.first(where: { $0.lowercased() == name }) { return [.openAgent(a)] }
                return agentHits.map { .fill("@\($0) ") } + projectHits.map { .fill("@\($0.slug) ") } + threadHits.prefix(5).map { .fill("@\($0.name) ") }
            }
            var out: [Action] = []
            if let a = agentHits.first(where: { $0.lowercased() == name }) ?? agentHits.first {
                out.append(.ask(agent: a, text: rest, assistant: a == assistant))
            }
            if let p = projectHits.first { out.append(.start(project: p.slug, name: p.name, text: rest)) }
            if let t = threadHits.first { out.append(.drive(thread: t.id, name: t.name, text: rest)) }
            return out
        }
        if let m = FindGrammar.match(s, #"^(?:tell|ask)\s+(?:the\s+)?(.+?)\s+(?:thread\s+)?to\s+(.+)$"#) {
            let ts = candidates(m[0])
            if !ts.isEmpty { return ts.prefix(4).map { .drive(thread: $0.id, name: $0.name, text: m[1]) } }
        }
        if let m = FindGrammar.match(s, #"^(?:watch|monitor|track)\s+(?:the\s+)?(.+?)(?:\s+thread)?$"#)
            ?? FindGrammar.match(s, #"^(?:tell|ping|notify)\s+me\s+when\s+(?:the\s+)?(.+?)(?:\s+thread)?\s+(?:is\s+done|finishes|asks).*$"#) {
            let ts = candidates(m[0])
            if !ts.isEmpty { return ts.prefix(4).map { .watch(thread: $0.id, name: $0.name) } }
        }
        guard let a = assistant else { return [] }
        return [.ask(agent: a, text: s, assistant: true)]
    }
}

/// Where the query's words appear in a text, for the `--match` highlight: every word of two or
/// more letters, case-insensitive, without overlaps.
func matchSpans(_ text: String, _ q: String) -> [Range<String.Index>] {
    let words = q.lowercased().split(whereSeparator: { $0.isWhitespace }).map(String.init).filter { $0.count >= 2 }
    var spans: [Range<String.Index>] = []
    for w in words {
        var from = text.startIndex
        while from < text.endIndex, let r = text.range(of: w, options: [.caseInsensitive, .diacriticInsensitive], range: from..<text.endIndex) {
            if !spans.contains(where: { $0.overlaps(r) }) { spans.append(r) }
            from = r.upperBound
        }
    }
    return spans.sorted { $0.lowerBound < $1.lowerBound }
}

/// A text with the query's words on `--match`.
func highlighted(_ text: String, _ q: String) -> AttributedString {
    var a = AttributedString(text)
    for r in matchSpans(text, q) {
        if let lo = AttributedString.Index(r.lowerBound, within: a), let hi = AttributedString.Index(r.upperBound, within: a) {
            a[lo..<hi].backgroundColor = Color.match
        }
    }
    return a
}

/// Find (phone.md section 7): the Capsule, opened as a full-height sheet. The search field and
/// Done; a segmented scope (All, Chats, Files, Memory, Run); then, as you type, Ask <assistant>,
/// Run (the Find grammar), From memory, Chats and Files. It searches 150 ms after the last
/// keystroke and cancels the search before. An empty query shows recent searches and the four
/// most recent sessions.
struct FindView: View {
    @Environment(AppModel.self) private var app
    @State private var q = ""
    @State private var scope: Scope = .all
    @State private var agents: [JSON] = []
    @State private var projects: [JSON] = []
    @State private var found = Found()
    @State private var busy = false
    @State private var note: String?
    @State private var sentThread: String?
    @AppStorage("find.recent") private var recentRaw = ""
    @FocusState private var focused: Bool

    enum Scope: String, CaseIterable, Identifiable, Hashable {
        case all, chats, files, memory, run
        var id: String { rawValue }
        var label: String {
            switch self { case .all: "All"; case .chats: "Chats"; case .files: "Files"; case .memory: "Memory"; case .run: "Run" }
        }
        func shows(_ s: Scope) -> Bool { self == .all || self == s }
    }

    /// One search's results: nil while it is out.
    struct Found: Equatable {
        var key = Key()
        var recall: Outcome?
        var files: Outcome?
        var memory: Outcome?
    }

    struct Key: Hashable { var q = ""; var scope: Scope = .all }

    enum Outcome: Equatable {
        case rows([JSON])
        case failed(String)
        var rows: [JSON] { if case .rows(let r) = self { return r }; return [] }
    }

    var body: some View {
        @Bindable var app = app
        NavigationStack(path: $app.findPath) {
            VStack(alignment: .leading, spacing: 12) {
                topRow
                segments
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        if let note { outcomeLine(note) }
                        if trimmed.isEmpty { idle } else { results }
                    }
                    .padding(.bottom, Space.xxl)
                }
                .scrollDismissesKeyboard(.interactively)
            }
            .padding(.horizontal, Space.gutter)
            .padding(.top, Space.s)
            .background(Color.panel)
            .toolbar(.hidden, for: .navigationBar)
            .vyreDestinations()
        }
        .task { await loadCatalog() }
        .task(id: key) { await search() }
        .onChange(of: q) { _, _ in note = nil; sentThread = nil }
        .onAppear { focused = true }
    }

    private var trimmed: String { q.trimmingCharacters(in: .whitespacesAndNewlines) }

    // MARK: the top

    private var topRow: some View {
        HStack(spacing: Space.m) {
            HStack(spacing: Space.s) {
                Image(systemName: "magnifyingglass").font(.system(size: 15, weight: .medium)).foregroundStyle(Color.label)
                TextField("", text: $q, prompt: Text("Ask \(assistantName), find, or run").foregroundStyle(Color.label))
                    .vyre(.input)
                    .foregroundStyle(Color.text)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.go)
                    .focused($focused)
                    .onSubmit { Task { await run(grammar.actions(q).first) } }
                if !q.isEmpty {
                    Button { q = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Color.label) }
                        .buttonStyle(.plain)
                        .frame(width: 32, height: 40)
                        .accessibilityLabel("Clear")
                }
            }
            .padding(.leading, Space.m)
            .frame(height: 40)
            .background(Color.hover, in: RoundedRectangle(cornerRadius: Radius.card))
            .overlay { RoundedRectangle(cornerRadius: Radius.card).strokeBorder(focused ? Color.focus : Color.rule, lineWidth: focused ? 2 : 1) }
            Button { app.sheet = nil } label: {
                Text("Done").vyre(.input).foregroundStyle(Color.text).frame(minHeight: Space.target)
            }
            .buttonStyle(.plain)
        }
        .frame(height: 52)
    }

    /// All, Chats, Files, Memory, Run: 32 tall, radius 9, a `--hover` track with a `--rule` border.
    private var segments: some View {
        HStack(spacing: 0) {
            ForEach(Scope.allCases) { s in
                let on = scope == s
                Button { scope = s; UISelectionFeedbackGenerator().selectionChanged() } label: {
                    Text(s.label).vyre(.small, weight: on ? 600 : 400)
                        .foregroundStyle(on ? Color.text : Color.text2)
                        .frame(maxWidth: .infinity, minHeight: 28)
                        .background(on ? Color.bg : Color.clear, in: RoundedRectangle(cornerRadius: 7))
                        .overlay { if on { RoundedRectangle(cornerRadius: 7).strokeBorder(Color.ruleStrong, lineWidth: 1) } }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(on ? .isSelected : [])
            }
        }
        .padding(2)
        .frame(height: 32)
        .background(Color.hover, in: RoundedRectangle(cornerRadius: 9))
        .overlay { RoundedRectangle(cornerRadius: 9).strokeBorder(Color.rule, lineWidth: 1) }
    }

    private func outcomeLine(_ text: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(text).vyre(.small).foregroundStyle(Color.text)
            Spacer()
            if let t = sentThread { Button("Open") { app.open(.thread(t)) }.buttonStyle(.quiet) }
        }
        .padding(Space.m)
        .background(Color.bg, in: RoundedRectangle(cornerRadius: Radius.card))
    }

    // MARK: the grammar

    private var assistant: String? { agents.first { $0["kind"].string == "assistant" }?["name"].string ?? app.assistantName }
    private var assistantName: String { assistant ?? app.assistantLabel }
    private var sessions: [JSON] { app.needs.threads.sorted { ($0["last"].double ?? 0) > ($1["last"].double ?? 0) } }

    private var grammar: FindGrammar {
        FindGrammar(agents: agents.compactMap { $0["name"].string }, assistant: assistant,
                    projects: projects.map { (slug: $0["slug"].text, name: $0["name"].string ?? $0["slug"].text) },
                    sessions: sessions.map { (id: $0["id"].text, name: threadLabel($0)) })
    }

    /// The words the searches run on: the question, or an @agent's text. None for a command that
    /// names a session.
    private var searchText: String {
        let s = trimmed
        guard s.count >= 2 else { return "" }
        if s.hasPrefix("@") {
            let rest = String(s.dropFirst().drop { !$0.isWhitespace }).trimmingCharacters(in: .whitespaces)
            return rest.count >= 2 ? rest : ""
        }
        switch grammar.actions(s).first {
        case .drive?, .watch?: return ""
        default: return s
        }
    }

    private var key: Key { Key(q: searchText, scope: scope) }

    // MARK: results

    @ViewBuilder
    private var results: some View {
        let acts = grammar.actions(q)
        let words = searchText
        let f = found.key == key ? found : Found(key: key)
        if scope.shows(.run) {
            if let ask = acts.first(where: \.isAssistantAsk) { askRow(ask) }
            let runs = acts.filter { !$0.isAssistantAsk }
            if !runs.isEmpty { runCard(runs) }
            if acts.isEmpty && assistant == nil && scope == .run {
                EmptyLine(text: "This box has no assistant yet. Try @ and an agent's name.")
            }
        }
        if !words.isEmpty {
            if scope.shows(.memory) { memoryBlock(f.memory, words) }
            if scope.shows(.chats) { chats(f.recall, words) }
            if scope.shows(.files) { files(f.files, words) }
        }
    }

    /// Ask <assistant>: the typed words as a question. Tap runs it and pushes the chat.
    private func askRow(_ a: FindGrammar.Action) -> some View {
        Button { Task { await run(a) } } label: {
            HStack(spacing: Space.m) {
                Tile(name: assistantName)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Ask \(assistantName)").vyre(.rowTitle).foregroundStyle(Color.text)
                    Text(trimmed).vyre(.secondary).foregroundStyle(Color.text2).lineLimit(2)
                }
                Spacer(minLength: Space.s)
                if busy { ProgressView().controlSize(.small) }
                else { Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(Color.label) }
            }
            .padding(.vertical, 12).padding(.horizontal, 14)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .background(Color.signalWash, in: RoundedRectangle(cornerRadius: Radius.card))
        .overlay { RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Color.rule, lineWidth: 1) }
    }

    /// Run: the matching commands, each its plain-words action and the command below in mono.
    private func runCard(_ acts: [FindGrammar.Action]) -> some View {
        Card(fill: .bg) {
            ForEach(Array(acts.enumerated()), id: \.offset) { i, a in
                if i > 0 { Hairline() }
                Button { Task { await run(a) } } label: {
                    HStack(alignment: .top, spacing: Space.m) {
                        Image(systemName: "terminal").font(.system(size: 18, weight: .regular)).foregroundStyle(Color.label).frame(width: 22)
                            .padding(.top, 1)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(highlighted(a.label, trimmed)).vyre(.rowTitle).foregroundStyle(Color.text).lineLimit(2)
                            Text(a.command).font(VyreFonts.base(.codeSmall).asFont(size: 12)).foregroundStyle(Color.label).lineLimit(2)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, 12).padding(.horizontal, 14)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(busy)
            }
        }
    }

    @ViewBuilder
    private func memoryBlock(_ o: Outcome?, _ words: String) -> some View {
        let facts = (o?.rows ?? []).filter { !($0["text"].string ?? "").isEmpty }
        if !facts.isEmpty || o == nil {
            VStack(alignment: .leading, spacing: Space.s) {
                HStack(spacing: 6) {
                    Image(systemName: "clock.arrow.circlepath").font(.system(size: 14))
                    Text("From memory").vyre(.small, weight: 600)
                }
                .foregroundStyle(Color.recall)
                if o == nil { Text("Looking.").vyre(.small).foregroundStyle(Color.text2) }
                ForEach(Array(facts.prefix(4).enumerated()), id: \.offset) { _, m in
                    NavigationLink(value: m["id"].string.map { Dest.fact($0) } ?? Dest.memory(words)) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(highlighted(m["text"].text, words)).vyre(.secondary).foregroundStyle(Color.text).multilineTextAlignment(.leading)
                            let meta = [m["source"].string, m["age"].string ?? (m["seen"].double ?? m["since"].double).map { age($0) }].compactMap { $0 }.filter { !$0.isEmpty }
                            if !meta.isEmpty { Text(meta.joined(separator: " · ")).vyre(.micro).foregroundStyle(Color.text2) }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.vertical, 12).padding(.horizontal, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.recallWash, in: RoundedRectangle(cornerRadius: Radius.card))
        } else if case .failed(let why)? = o, scope == .memory {
            FailedLine(text: "Memory was not searched. \(why)")
        } else if scope == .memory {
            EmptyLine(text: "Nothing in memory.")
        }
    }

    private func matches(_ q: String, _ name: String) -> Bool {
        let n = name.lowercased(), w = q.lowercased()
        return n.contains(w) || w.split(separator: " ").contains { $0.count >= 3 && n.contains($0) }
    }

    @ViewBuilder
    private func chats(_ o: Outcome?, _ words: String) -> some View {
        let byName = sessions.filter { matches(words, threadLabel($0)) }
        let hits = (o?.rows ?? []).filter { h in !byName.contains { $0["id"].string == h["session"].string } }
        if !byName.isEmpty || !hits.isEmpty || scope == .chats {
            Text("Chats").vyre(.title).foregroundStyle(Color.text).padding(.top, Space.xs)
            if byName.isEmpty && hits.isEmpty {
                if case .failed(let why)? = o { FailedLine(text: "Chats were not searched. \(why)") }
                else { EmptyLine(text: o == nil ? "Looking." : "Nothing found.") }
            } else {
                let list: [ChatHit] = Array((byName.map { ChatHit(thread: $0) } + hits.map { ChatHit(recall: $0) }).prefix(12))
                Card(fill: .bg) {
                    ForEach(Array(list.enumerated()), id: \.offset) { i, h in
                        if i > 0 { Hairline() }
                        NavigationLink(value: Dest.thread(h.id)) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(h.name).vyre(.rowTitle).foregroundStyle(Color.text).lineLimit(1)
                                if !h.snippet.isEmpty { Text(highlighted(h.snippet, words)).vyre(.secondary).foregroundStyle(Color.text2).lineLimit(1) }
                                if !h.meta.isEmpty { Text(h.meta).vyre(.small).foregroundStyle(Color.label).lineLimit(1) }
                            }
                            .padding(.vertical, 12).padding(.horizontal, 14)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .simultaneousGesture(TapGesture().onEnded { remember() })
                    }
                }
            }
        }
    }

    /// One Chats result: a live session matched by name, or a recalled one matched by its words.
    private struct ChatHit {
        let id: String
        let name: String
        let snippet: String
        let meta: String
        init(thread t: JSON) {
            id = t["id"].text
            name = threadLabel(t)
            snippet = t["last_text"].string ?? ""
            meta = [t["project"].string, age(t["last"].double)].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
        }
        init(recall h: JSON) {
            id = h["session"].text
            name = h["title"].string ?? h["name"].string ?? String(h["session"].text.prefix(8))
            snippet = (h["snippet"].string ?? h["text"].string ?? "").replacingOccurrences(of: "\u{00AB}", with: "")
                .replacingOccurrences(of: "\u{00BB}", with: "").replacingOccurrences(of: "\n", with: " ")
            meta = [h["project"].string, age(h["ts"].double)].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
        }
    }

    @ViewBuilder
    private func files(_ o: Outcome?, _ words: String) -> some View {
        let rows = o?.rows ?? []
        if !rows.isEmpty || scope == .files {
            Text("Files").vyre(.title).foregroundStyle(Color.text).padding(.top, Space.xs)
            if rows.isEmpty {
                if case .failed(let why)? = o { FailedLine(text: "Files were not searched. \(why)") }
                else { EmptyLine(text: o == nil ? "Looking." : "Nothing on the box.") }
            } else {
                Card(fill: .bg) {
                    ForEach(Array(rows.prefix(20).enumerated()), id: \.offset) { i, x in
                        if i > 0 { Hairline() }
                        NavigationLink(value: Dest.file(x)) {
                            HStack(alignment: .top, spacing: Space.m) {
                                Image(systemName: "doc").font(.system(size: 18)).foregroundStyle(Color.label).frame(width: 22).padding(.top, 1)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(highlighted(x["path"].string ?? x["name"].text, words)).vyre(.code).foregroundStyle(Color.text).lineLimit(2)
                                    let meta = [x["repo"].string ?? x["project"].string, x["machine"].string ?? (x["source"].string == "mac" ? "Mac" : "box")]
                                        .compactMap { $0 }.joined(separator: " · ")
                                    Text(meta).vyre(.small).foregroundStyle(Color.label).lineLimit(1)
                                }
                                Spacer(minLength: 0)
                            }
                            .padding(.vertical, 12).padding(.horizontal, 14)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .simultaneousGesture(TapGesture().onEnded { remember() })
                    }
                }
            }
            if !rows.contains(where: { $0["source"].string == "mac" }) {
                Text("Files on your Macs show here when they are online.").vyre(.small).foregroundStyle(Color.label)
            }
        }
    }

    // MARK: the empty query

    private var recent: [String] { recentRaw.split(separator: "\n").map(String.init) }

    /// Keep what was searched, the latest first, six at most (this phone only).
    private func remember() {
        let s = trimmed
        guard s.count >= 2 else { return }
        recentRaw = ([s] + recent.filter { $0 != s }).prefix(6).joined(separator: "\n")
    }

    @ViewBuilder
    private var idle: some View {
        if !recent.isEmpty {
            HStack {
                Text("Recent").vyre(.title).foregroundStyle(Color.text)
                Spacer()
                Button("Clear") { recentRaw = "" }.buttonStyle(.quiet)
            }
            Card(fill: .bg) {
                ForEach(Array(recent.enumerated()), id: \.offset) { i, r in
                    if i > 0 { Hairline() }
                    Button { q = r; focused = true } label: {
                        HStack(spacing: Space.m) {
                            Image(systemName: "clock").font(.system(size: 16)).foregroundStyle(Color.label)
                            Text(r).vyre(.secondary).foregroundStyle(Color.text).lineLimit(1)
                            Spacer()
                        }
                        .padding(.horizontal, 14).frame(minHeight: Space.target)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        Text("Chats").vyre(.title).foregroundStyle(Color.text).padding(.top, Space.xs)
        if sessions.isEmpty {
            EmptyLine(text: "No sessions yet. Ask \(assistantName) something to start one.")
        } else {
            Card(fill: .bg) {
                ForEach(Array(sessions.prefix(4).enumerated()), id: \.offset) { i, t in
                    if i > 0 { Hairline() }
                    NavigationLink(value: Dest.thread(t["id"].text)) { SessionRow(t: t) }.buttonStyle(.plain)
                }
            }
        }
    }

    // MARK: running it

    private func run(_ a: FindGrammar.Action?) async {
        guard let a, !busy else { return }
        switch a {
        case .fill(let s): q = s; focused = true; return
        case .openAgent(let name): remember(); q = ""; app.findPath.append(.agent(name)); return
        default: break
        }
        remember()
        busy = true
        defer { busy = false }
        do {
            switch a {
            case .ask(let agent, let text, _):
                let out = try await app.call("agents.ask", ["agent": .string(agent), "text": .string(text), "surface": "ios", "wait": false])
                if out["ok"].bool == false { note = out["note"].string ?? "\(agent) did not take it."; return }
                q = ""
                if let t = out["thread"].string { app.open(.thread(t)) } else { note = "Sent to \(agent)." }
            case .start(let project, let name, let text):
                let rec = try await app.call("threads.start", ["project": .string(project), "prompt": .string(text), "surface": "ios"])
                q = ""
                if let t = rec["id"].string { app.open(.thread(t)) } else { note = "Started a session on \(name)." }
            case .drive(let thread, let name, let text):
                let out = try await app.call("threads.send", ["thread": .string(thread), "text": .string(text), "surface": "ios"])
                guard out["sent"].bool == true else { note = out["note"].string ?? "\(out["holder"].string ?? "Someone") has the keyboard."; return }
                _ = try? await app.call("threads.watch", ["thread": .string(thread), "until": "either", "notify": "ios", "note": .string("Tell \(name): \(text)")])
                note = "Sent to \(name). You will hear when it finishes or asks."
                sentThread = thread
                q = ""
            case .watch(let thread, let name):
                _ = try await app.call("threads.watch", ["thread": .string(thread), "until": "either", "notify": "ios", "note": .string("Watch \(name)")])
                note = "Watching \(name). You will hear when it finishes or asks."
                sentThread = thread
                q = ""
            case .fill, .openAgent: return
            }
            Haptics.success()
        } catch where isCancel(error) {
        } catch { note = describe(error) }
    }

    private func loadCatalog() async {
        if let a = try? await app.call("agents.list") { agents = a.list; app.cache.put("agents.list", a) }
        else if let c = app.cache.get("agents.list") { agents = c.list }
        if let p = try? await app.call("projects.list") { projects = p["projects"].list }
        else if let c = app.cache.get("projects.list") { projects = c["projects"].list }
    }

    /// 150 ms after the last keystroke; a new keystroke (or scope) cancels this task and the
    /// requests in it. Only the searches the scope shows are run.
    private func search() async {
        let k = key
        guard !k.q.isEmpty else { found = Found(key: k); return }
        try? await Task.sleep(for: .milliseconds(150))
        if Task.isCancelled { return }
        found = Found(key: k)
        let s = k.q
        async let r = recall(s, when: k.scope.shows(.chats))
        async let f = fileHits(s, when: k.scope.shows(.files))
        async let m = memory(s, when: k.scope.shows(.memory))
        let (rr, ff, mm) = await (r, f, m)
        if Task.isCancelled || key != k { return }
        found = Found(key: k, recall: rr, files: ff, memory: mm)
    }

    private func recall(_ s: String, when: Bool) async -> Outcome? {
        guard when else { return nil }
        return await outcome { try await app.call("recall.search", ["q": .string(s), "limit": 20, "per_session": 1]).list }
    }

    private func fileHits(_ s: String, when: Bool) async -> Outcome? {
        guard when else { return nil }
        return await outcome { try await app.call("files.search", ["q": .string(s), "limit": 20])["results"].list }
    }

    /// memory.relevant over the tailnet needs a room for the main graph (CONTRACT.md 4.2);
    /// memory.facts about the words is the fallback.
    private func memory(_ s: String, when: Bool) async -> Outcome? {
        guard when else { return nil }
        return await outcome {
            do { return try await app.call("memory.relevant", ["text": .string(s), "limit": 5]).list }
            catch { return try await app.call("memory.facts", ["about": .string(s), "limit": 5])["facts"].list }
        }
    }

    private func outcome(_ work: @MainActor () async throws -> [JSON]) async -> Outcome {
        do { return .rows(try await work()) } catch { return .failed(describe(error)) }
    }
}
