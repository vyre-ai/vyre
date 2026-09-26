import SwiftUI

/// Find (the phone PWA's Capsule, views/find.js; the Android FindScreen): one box. Plain words
/// ask the assistant; `@agent` messages an agent (alone, it opens the agent); `@project` starts a
/// session there and `@thread` types into one; "tell X to Y" types into a session and watches it,
/// "watch X" waits for it. What Enter will do is written under the box. As you type, results come
/// in the PWA's order: sessions, files (the box's), agents, memory, projects. With the box empty:
/// Places (Vault, Memory), examples, and recent sessions.
struct FindView: View {
    @Environment(AppModel.self) private var app
    @State private var q = ""
    @State private var agents: [JSON] = []
    @State private var projects: [JSON] = []
    @State private var found = Found()
    @State private var busy = false
    @State private var note: String?
    @State private var sentThread: String?
    @State private var voiceNote = false
    @FocusState private var focused: Bool

    /// One search's results: nil while it is out.
    struct Found: Equatable {
        var q = ""
        var recall: Outcome?
        var files: Outcome?
        var memory: Outcome?
    }

    enum Outcome: Equatable {
        case rows([JSON])
        case failed(String)
        var rows: [JSON] { if case .rows(let r) = self { return r }; return [] }
    }

    var body: some View {
        @Bindable var app = app
        NavigationStack(path: $app.findPath) {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.l) {
                    HStack {
                        PageHead(title: "Find")
                        Button("Done") { app.sheet = nil }.buttonStyle(.quiet)
                    }
                    box
                    if let note { outcomeLine(note) }
                    if !actions.isEmpty { enterRows }
                    if !searchText.isEmpty { results }
                    if q.trimmingCharacters(in: .whitespaces).isEmpty { idle }
                }
                .padding(.horizontal, Space.gutter)
                .padding(.bottom, Space.xxl)
            }
            .scrollDismissesKeyboard(.interactively)
            .vyreGround()
            .toolbar(.hidden, for: .navigationBar)
            .vyreDestinations()
        }
        .task { await loadCatalog() }
        .task(id: searchText) { await search() }
        .onChange(of: q) { _, _ in note = nil; sentThread = nil }
    }

    // MARK: the box

    private var box: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            HStack(spacing: Space.s) {
                HStack(spacing: Space.s) {
                    Image(systemName: "magnifyingglass").font(.system(size: 15, weight: .medium)).foregroundStyle(Color.label)
                    TextField("", text: $q, prompt: Text("Find or ask, @agent, tell or watch").foregroundStyle(Color.label))
                        .vyre(.body)
                        .foregroundStyle(Color.text)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.go)
                        .focused($focused)
                        .onSubmit { Task { await run(actions.first) } }
                    if !q.isEmpty {
                        Button { q = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Color.label) }
                            .buttonStyle(.plain).accessibilityLabel("Clear")
                    }
                }
                .padding(.horizontal, Space.m)
                .frame(minHeight: Space.target)
                .background(Color.panel, in: RoundedRectangle(cornerRadius: Radius.button))
                .overlay {
                    RoundedRectangle(cornerRadius: Radius.button).strokeBorder(focused ? Color.focus : Color.ruleStrong, lineWidth: focused ? 2 : 1)
                }
                // Voice needs on-device recognition (ADR 0018 section 8); this build has none yet.
                Button { voiceNote.toggle() } label: {
                    Image(systemName: "mic").font(.system(size: 17, weight: .medium)).foregroundStyle(Color.rule)
                        .frame(width: Space.target, height: Space.target)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Voice, not available in this build")
            }
            Text(hint ?? "Voice is not in this build yet. Type instead.")
                .vyre(.small).foregroundStyle(hint != nil ? Color.text2 : Color.label)
            if voiceNote {
                Text("Voice will listen on this phone only and put the words here to read before sending.")
                    .vyre(.small).foregroundStyle(Color.label)
            }
        }
    }

    private func outcomeLine(_ text: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(text).vyre(.small).foregroundStyle(Color.text)
            Spacer()
            if let t = sentThread { Button("Open") { app.open(.thread(t)) }.buttonStyle(.quiet) }
        }
        .padding(Space.m)
        .background(Color.panel, in: RoundedRectangle(cornerRadius: Radius.panel))
    }

    // MARK: what Enter does

    enum Action: Equatable {
        case ask(agent: String, text: String, assistant: Bool)
        case openAgent(String)
        case start(project: String, name: String, text: String)
        case drive(thread: String, name: String, text: String)
        case watch(thread: String, name: String)
        case fill(String)

        var label: String {
            switch self {
            case .ask(let a, _, let assistant): assistant ? "Ask \(a), the assistant" : "Ask @\(a)"
            case .openAgent(let a): "Open @\(a)"
            case .start(_, let n, _): "Start a session in \(n)"
            case .drive(_, let n, _): "Type into \(n), then watch it"
            case .watch(_, let n): "Watch \(n)"
            case .fill(let s): s.trimmingCharacters(in: .whitespaces)
            }
        }
        var detail: String? {
            switch self {
            case .ask(_, let t, _), .start(_, _, let t), .drive(_, _, let t): t
            case .watch: "You will hear when it finishes or asks."
            case .openAgent, .fill: nil
            }
        }
    }

    private var assistant: String? { agents.first { $0["kind"].string == "assistant" }?["name"].string }
    private var sessions: [JSON] { app.needs.threads.sorted { ($0["last"].double ?? 0) > ($1["last"].double ?? 0) } }

    /// Sessions whose name the words match, best first.
    private func candidates(_ words: String) -> [JSON] {
        let w = words.lowercased().trimmingCharacters(in: .whitespaces)
        guard !w.isEmpty else { return [] }
        let exact = sessions.filter { threadLabel($0).lowercased() == w }
        let part = sessions.filter { threadLabel($0).lowercased().contains(w) && !exact.contains($0) }
        return exact + part
    }

    private static func match(_ s: String, _ pattern: String) -> [String]? {
        guard let re = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]),
              let m = re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) else { return nil }
        return (1..<m.numberOfRanges).map { i in Range(m.range(at: i), in: s).map { String(s[$0]) } ?? "" }
    }

    var actions: [Action] {
        let s = q.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return [] }
        if s.hasPrefix("@") {
            let body = s.dropFirst()
            let name = String(body.prefix { !$0.isWhitespace }).lowercased()
            let rest = String(body.drop { !$0.isWhitespace }).trimmingCharacters(in: .whitespaces)
            let typedSpace = q.hasSuffix(" ")
            let agentHits = agents.compactMap { $0["name"].string }.filter { $0.lowercased().hasPrefix(name) }
            let projectHits = projects.filter { ($0["slug"].string ?? "").lowercased().hasPrefix(name) }
            let threadHits = sessions.filter { threadLabel($0).lowercased().hasPrefix(name) }
            if rest.isEmpty {
                if typedSpace || agentHits.contains(where: { $0.lowercased() == name }), let a = agentHits.first(where: { $0.lowercased() == name }) {
                    return [.openAgent(a)]
                }
                return agentHits.map { .fill("@\($0) ") } + projectHits.map { .fill("@\($0["slug"].text) ") } + threadHits.prefix(5).map { .fill("@\(threadLabel($0)) ") }
            }
            var out: [Action] = []
            if let a = agentHits.first(where: { $0.lowercased() == name }) ?? agentHits.first {
                out.append(.ask(agent: a, text: rest, assistant: a == assistant))
            }
            if let p = projectHits.first { out.append(.start(project: p["slug"].text, name: p["name"].string ?? p["slug"].text, text: rest)) }
            if let t = threadHits.first { out.append(.drive(thread: t["id"].text, name: threadLabel(t), text: rest)) }
            return out
        }
        if let m = FindView.match(s, #"^(?:tell|ask)\s+(?:the\s+)?(.+?)\s+(?:thread\s+)?to\s+(.+)$"#) {
            let ts = candidates(m[0])
            if !ts.isEmpty { return ts.prefix(4).map { .drive(thread: $0["id"].text, name: threadLabel($0), text: m[1]) } }
        }
        if let m = FindView.match(s, #"^(?:watch|monitor|track)\s+(?:the\s+)?(.+?)(?:\s+thread)?$"#)
            ?? FindView.match(s, #"^(?:tell|ping|notify)\s+me\s+when\s+(?:the\s+)?(.+?)(?:\s+thread)?\s+(?:is\s+done|finishes|asks).*$"#) {
            let ts = candidates(m[0])
            if !ts.isEmpty { return ts.prefix(4).map { .watch(thread: $0["id"].text, name: threadLabel($0)) } }
        }
        guard let a = assistant else { return [] }
        return [.ask(agent: a, text: s, assistant: true)]
    }

    private var hint: String? {
        let s = q.trimmingCharacters(in: .whitespaces)
        guard !s.isEmpty else { return nil }
        guard let a = actions.first else { return assistant == nil ? "This box has no assistant yet. Try @ and an agent's name." : nil }
        if case .fill = a { return "Choose one, or keep typing." }
        return "Enter: \(a.label)."
    }

    /// The words the searches run on: the question, or an @agent's text.
    private var searchText: String {
        let s = q.trimmingCharacters(in: .whitespacesAndNewlines)
        guard s.count >= 2 else { return "" }
        if s.hasPrefix("@") {
            let rest = String(s.dropFirst().drop { !$0.isWhitespace }).trimmingCharacters(in: .whitespaces)
            return rest.count >= 2 ? rest : ""
        }
        switch actions.first {
        case .drive?, .watch?: return ""
        default: return s
        }
    }

    private var enterRows: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionHead(title: "Enter does").padding(.bottom, Space.s)
            Hairline()
            ForEach(Array(actions.enumerated()), id: \.offset) { i, a in
                Button { Task { await run(a) } } label: {
                    ListRow(title: a.label, detail: a.detail, note: i == 0 ? "return" : nil, dot: i == 0 ? .focus : nil, chevron: false)
                }
                .buttonStyle(.plain)
                .disabled(busy)
            }
        }
    }

    // MARK: results, in the PWA's order

    private func matches(_ q: String, _ name: String) -> Bool {
        let n = name.lowercased(), w = q.lowercased()
        return n.contains(w) || w.split(separator: " ").contains { $0.count >= 3 && n.contains($0) }
    }

    @ViewBuilder
    private var results: some View {
        let q = searchText
        let f = found.q == q ? found : Found(q: q)
        let byName = sessions.filter { matches(q, threadLabel($0)) }
        let hits = (f.recall?.rows ?? []).filter { h in !byName.contains { $0["id"].string == h["session"].string } }
        group("Sessions", byName.count + hits.count) {
            ForEach(byName, id: \.self) { t in
                NavigationLink(value: Dest.thread(t["id"].text)) {
                    ListRow(title: threadLabel(t), detail: [t["agent"].string, t["status"].string].compactMap { $0 }.joined(separator: " · "),
                            dot: statusDot(t["status"].string, asks: t["asks"].int ?? 0))
                }.buttonStyle(.plain)
            }
            ForEach(hits, id: \.self) { h in
                NavigationLink(value: Dest.thread(h["session"].text)) {
                    ListRow(title: h["title"].string ?? h["name"].string ?? String(h["session"].text.prefix(8)),
                            detail: (h["snippet"].string ?? h["text"].string)?.replacingOccurrences(of: "\u{00AB}", with: "")
                                .replacingOccurrences(of: "\u{00BB}", with: "").replacingOccurrences(of: "\n", with: " "),
                            note: age(h["ts"].double))
                }.buttonStyle(.plain)
            }
            status(f.recall, failed: "Sessions were not searched.", empty: byName.isEmpty ? "Nothing found." : nil)
        }

        let files = f.files?.rows ?? []
        group("Files", files.count, note: "box") {
            ForEach(files, id: \.self) { x in
                NavigationLink(value: Dest.file(x)) {
                    ListRow(title: x["name"].string ?? x["path"].text, detail: x["path"].string,
                            note: [x["kind"].string, byteSize(x["size"].double)].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                }.buttonStyle(.plain)
            }
            status(f.files, failed: "Files were not searched.", empty: "Nothing on the box. Files on the Mac cannot be reached from a phone yet.")
        }

        let ag = agents.filter { matches(q, $0["name"].text) }
        if !ag.isEmpty {
            group("Agents", ag.count) {
                ForEach(ag, id: \.self) { a in
                    NavigationLink(value: Dest.agent(a["name"].text)) {
                        ListRow(title: "@" + a["name"].text, detail: [a["kind"].string, a["doing"].string].compactMap { $0 }.joined(separator: " · "))
                    }.buttonStyle(.plain)
                }
            }
        }

        let mem = (f.memory?.rows ?? []).filter { !($0["text"].string ?? "").isEmpty }
        group("From memory", mem.count, color: .recall) {
            ForEach(mem, id: \.self) { m in
                NavigationLink(value: m["id"].string.map { Dest.fact($0) } ?? Dest.memory(q)) {
                    ListRow(title: m["text"].text, detail: [m["age"].string, m["source"].string].compactMap { $0 }.joined(separator: " · "), dot: .recall)
                }.buttonStyle(.plain)
            }
            status(f.memory, failed: "Memory was not searched.", empty: "Nothing in memory.")
            NavigationLink(value: Dest.memory(q)) { ListRow(title: "Open Memory about \"\(q)\"", chevron: true) }.buttonStyle(.plain)
        }

        let pr = projects.filter { matches(q, $0["name"].string ?? $0["slug"].text) }
        if !pr.isEmpty {
            group("Projects", pr.count) {
                ForEach(pr, id: \.self) { p in
                    NavigationLink(value: Dest.project(slug: p["slug"].text, name: p["name"].string ?? p["slug"].text)) {
                        ListRow(title: p["name"].string ?? p["slug"].text, detail: p["org"].string)
                    }.buttonStyle(.plain)
                }
            }
        }
    }

    private func group<C: View>(_ title: String, _ count: Int, note: String? = nil, color: Color = .label, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionHead(title: "\(title) · \(count)", note: note, color: color).padding(.bottom, Space.s)
            Hairline()
            content()
        }
    }

    @ViewBuilder
    private func status(_ o: Outcome?, failed: String, empty: String?) -> some View {
        switch o {
        case nil: HStack(spacing: Space.s) { ProgressView().tint(Color.label); Engraved("Looking") }.padding(.vertical, Space.m)
        case .failed(let why)?: EmptyLine(text: "\(failed) \(why)")
        case .rows(let r)?: if r.isEmpty, let empty { EmptyLine(text: empty) }
        }
    }

    // MARK: the empty box

    @ViewBuilder
    private var idle: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionHead(title: "Places").padding(.bottom, Space.s)
            Hairline()
            NavigationLink(value: Dest.vault) { ListRow(title: "Vault", detail: "Names on the box. A value shows only after Face ID.") }.buttonStyle(.plain)
            NavigationLink(value: Dest.memory(nil)) { ListRow(title: "Memory", detail: "What Vyre has learned, and where from.") }.buttonStyle(.plain)
        }
        VStack(alignment: .leading, spacing: Space.s) {
            SectionHead(title: "Try")
            Hairline()
            FlowChips(items: tries) { t in
                q = t
                focused = true
            }
        }
        VStack(alignment: .leading, spacing: 0) {
            SectionHead(title: "Sessions · \(sessions.count)", note: sessions.isEmpty ? nil : "Tap to open").padding(.bottom, Space.s)
            Hairline()
            if sessions.isEmpty { EmptyLine(text: "No session ran in the last day.") }
            ForEach(sessions.prefix(12), id: \.self) { t in
                NavigationLink(value: Dest.thread(t["id"].text)) {
                    ListRow(title: threadLabel(t), detail: [t["agent"].string, t["status"].string].compactMap { $0 }.joined(separator: " · "),
                            note: age(t["last"].double), dot: statusDot(t["status"].string, asks: t["asks"].int ?? 0))
                }.buttonStyle(.plain)
            }
        }
    }

    private var tries: [String] {
        var out = ["What came in overnight?"]
        if let a = agents.compactMap({ $0["name"].string }).first(where: { $0 != assistant }) { out.append("@\(a) ") }
        if let t = sessions.first {
            out.append("watch \(threadLabel(t))")
            out.append("tell \(threadLabel(t)) to ")
        }
        return out
    }

    // MARK: running it

    private func run(_ a: Action?) async {
        guard let a, !busy else { return }
        switch a {
        case .fill(let s): q = s; focused = true; return
        case .openAgent(let name): q = ""; app.findPath.append(.agent(name)); return
        default: break
        }
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
                if let t = rec["id"].string { app.open(.thread(t)) } else { note = "Started a session in \(name)." }
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

    /// Runs once the person pauses typing (300 ms): the task restarts on every change of the words.
    private func search() async {
        let s = searchText
        guard !s.isEmpty else { found = Found(); return }
        try? await Task.sleep(for: .milliseconds(300))
        if Task.isCancelled { return }
        found = Found(q: s)
        async let r = outcome { try await app.call("recall.search", ["q": .string(s), "limit": 20, "per_session": 1]).list }
        async let f = outcome { try await app.call("files.search", ["q": .string(s), "limit": 20])["results"].list }
        async let m = outcome {
            // memory.relevant over the tailnet needs a room for the main graph (CONTRACT.md 4.2);
            // memory.facts about the words is the fallback.
            do { return try await app.call("memory.relevant", ["text": .string(s), "limit": 5]).list }
            catch { return try await app.call("memory.facts", ["about": .string(s), "limit": 5])["facts"].list }
        }
        let (rr, ff, mm) = await (r, f, m)
        if Task.isCancelled || found.q != s { return }
        found = Found(q: s, recall: rr, files: ff, memory: mm)
    }

    private func outcome(_ work: @MainActor () async throws -> [JSON]) async -> Outcome {
        do { return .rows(try await work()) } catch { return .failed(describe(error)) }
    }
}

/// Chips that wrap onto new lines, for Find's examples.
struct FlowChips: View {
    let items: [String]
    let tap: (String) -> Void

    var body: some View {
        FlowLayout(spacing: Space.s) {
            ForEach(items, id: \.self) { t in
                Button { tap(t) } label: {
                    Text(t.trimmingCharacters(in: .whitespaces)).vyre(.code).foregroundStyle(Color.text2)
                        .padding(.horizontal, Space.m)
                        .frame(minHeight: 36)
                        .background(Color.panel, in: RoundedRectangle(cornerRadius: Radius.chip))
                        .overlay { RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Color.ruleStrong, lineWidth: 1) }
                }
                .buttonStyle(.plain)
            }
        }
    }
}

/// A left-to-right layout that wraps.
struct FlowLayout: Layout {
    var spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0, widest: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x > 0 && x + s.width > width { x = 0; y += line + spacing; line = 0 }
            x += s.width + spacing
            line = max(line, s.height)
            widest = max(widest, x - spacing)
        }
        return CGSize(width: proposal.width ?? widest, height: y + line)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, line: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x > bounds.minX && x + s.width > bounds.maxX { x = bounds.minX; y += line + spacing; line = 0 }
            v.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(s))
            x += s.width + spacing
            line = max(line, s.height)
        }
    }
}
