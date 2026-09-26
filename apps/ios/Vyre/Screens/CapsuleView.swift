import SwiftUI

/// The mobile Capsule: one box. Plain words ask the assistant; `@agent` messages an agent,
/// `@project` starts a session there, `@thread` types into a session; "tell X to Y" drives a
/// session and "watch X" waits for it. Past sessions that match come from recall. The Mac's
/// local/capsule/lib/route.js and launcher.js, on the tools the phone may call (CONTRACT.md 9).
struct CapsuleView: View {
    @Environment(AppModel.self) private var app
    @State private var q = ""
    @State private var agents: [JSON] = []
    @State private var projects: [JSON] = []
    @State private var hits: [JSON] = []
    @State private var busy = false
    @State private var done: Done?
    @State private var problem: String?
    @State private var voiceNote = false

    struct Done: Equatable { let text: String; let thread: String? }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.l) {
                PageHead(eyebrow: "Capsule", title: "Ask, tell, or watch.")
                HStack(spacing: Space.s) {
                    SearchField(text: $q, prompt: assistant.map { "Ask \($0)" } ?? "Ask, @agent, @project", submit: { Task { await run(actions.first) } })
                    Button { voiceNote.toggle() } label: {
                        Image(systemName: "mic").font(.system(size: 17, weight: .medium)).foregroundStyle(Color.ash)
                            .frame(width: Space.target, height: Space.target)
                            .background(Color.panel, in: RoundedRectangle(cornerRadius: Radius.button))
                            .overlay { RoundedRectangle(cornerRadius: Radius.button).strokeBorder(Color.ruleStrong, lineWidth: 1) }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Voice, not available yet")
                }
                if voiceNote {
                    Text("Voice is not in this build yet. It will listen on this phone only and put the words in the box to read before sending.")
                        .vyre(.small).foregroundStyle(Color.stone)
                }
                if let problem { FailedLine(text: problem) }
                if let done {
                    VStack(alignment: .leading, spacing: Space.s) {
                        Text(done.text).vyre(.body).foregroundStyle(Color.bone)
                        if let t = done.thread {
                            Button("Open the session") { app.open(.thread(t)) }.buttonStyle(.secondary)
                        }
                    }
                    .padding(Space.gutter)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.signalWash, in: RoundedRectangle(cornerRadius: Radius.panel))
                }
                if !actions.isEmpty {
                    VStack(alignment: .leading, spacing: 0) {
                        SectionHead(title: "Enter does").padding(.bottom, Space.s)
                        Hairline()
                        ForEach(Array(actions.enumerated()), id: \.offset) { i, a in
                            Button { Task { await run(a) } } label: {
                                ListRow(title: a.label, detail: a.detail, note: i == 0 ? "return" : nil, dot: i == 0 ? .signal : nil, chevron: false)
                            }
                            .buttonStyle(.plain)
                            .disabled(busy)
                        }
                    }
                } else if q.isEmpty {
                    hints
                }
                if !hits.isEmpty {
                    VStack(alignment: .leading, spacing: 0) {
                        SectionHead(title: "From past sessions", color: .recall).padding(.bottom, Space.s)
                        Hairline()
                        ForEach(hits, id: \.self) { h in
                            Button { app.open(.thread(h["session"].text)) } label: {
                                ListRow(title: h["title"].string ?? h["name"].string ?? "A session",
                                        detail: h["snippet"].string.map { $0.replacingOccurrences(of: "\u{00AB}", with: "").replacingOccurrences(of: "\u{00BB}", with: "") } ?? h["text"].string,
                                        note: age(h["ts"].double), dot: .recall)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            .padding(.horizontal, Space.gutter)
            .padding(.bottom, Space.xxl)
        }
        .scrollDismissesKeyboard(.interactively)
        .vyreGround()
        .task { await loadCatalog() }
        .task(id: q) { await search() }
        .onChange(of: q) { _, _ in done = nil; problem = nil }
    }

    private var hints: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            Engraved("Try")
            ForEach(["What did Harlow Legal send last week?", "@kit check the Northwind Bakery order", "tell invoices to add the late fee", "watch invoices"], id: \.self) { s in
                Button { q = s } label: { Text(s).vyre(.code).foregroundStyle(Color.stone).frame(maxWidth: .infinity, alignment: .leading) }
                    .buttonStyle(.plain)
                    .frame(minHeight: Space.target)
            }
        }
    }

    // MARK: what Enter does

    enum Action: Equatable {
        case ask(agent: String, text: String, assistant: Bool)
        case start(project: String, name: String, text: String)
        case send(thread: String, name: String, text: String)
        case watch(thread: String, name: String)
        case fill(String)

        var label: String {
            switch self {
            case .ask(let a, _, let assistant): assistant ? "Ask \(a)" : "Message \(a)"
            case .start(_, let n, _): "Start a session in \(n)"
            case .send(_, let n, _): "Tell \(n)"
            case .watch(_, let n): "Watch \(n)"
            case .fill(let s): s
            }
        }
        var detail: String? {
            switch self {
            case .ask(_, let t, _), .start(_, _, let t), .send(_, _, let t): t
            case .watch: "A notification when it finishes a turn or asks you something."
            case .fill: nil
            }
        }
    }

    private var assistant: String? { agents.first { $0["kind"].string == "assistant" }?["name"].string }
    private var threads: [JSON] { app.needs.threads }

    private func threadMatch(_ words: String) -> JSON? {
        let w = words.lowercased().trimmingCharacters(in: .whitespaces)
        guard !w.isEmpty else { return nil }
        return threads.first { ($0["name"].string ?? "").lowercased() == w }
            ?? threads.first { ($0["name"].string ?? "").lowercased().contains(w) }
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
            var out: [Action] = []
            let agentHits = agents.compactMap { $0["name"].string }.filter { $0.lowercased().hasPrefix(name) }
            let projectHits = projects.filter { ($0["slug"].string ?? "").lowercased().hasPrefix(name) }
            let threadHits = threads.filter { ($0["name"].string ?? "").lowercased().hasPrefix(name) }
            if rest.isEmpty {
                return agentHits.map { .fill("@\($0) ") } + projectHits.map { .fill("@\($0["slug"].text) ") } + threadHits.prefix(5).map { .fill("@\($0["name"].text) ") }
            }
            if let a = agentHits.first(where: { $0.lowercased() == name }) ?? agentHits.first {
                // The words may name one of this agent's threads: offer that first.
                for t in threads where t["agent"].string == a {
                    if let n = t["name"].string, rest.lowercased().contains(n.lowercased()) { out.append(.send(thread: t["id"].text, name: n, text: rest)) }
                }
                out.append(.ask(agent: a, text: rest, assistant: a == assistant))
            }
            if let p = projectHits.first {
                out.append(.start(project: p["slug"].text, name: p["name"].string ?? p["slug"].text, text: rest))
            }
            if let t = threadHits.first { out.append(.send(thread: t["id"].text, name: t["name"].text, text: rest)) }
            return out
        }
        if let m = CapsuleView.match(s, #"^(?:tell|ask)\s+(?:the\s+)?(.+?)\s+(?:thread\s+)?to\s+(.+)$"#), let t = threadMatch(m[0]) {
            return [.send(thread: t["id"].text, name: t["name"].text, text: m[1])] + askAssistant(s)
        }
        if let m = CapsuleView.match(s, #"^(?:watch|monitor|track)\s+(?:the\s+)?(.+?)(?:\s+thread)?$"#)
            ?? CapsuleView.match(s, #"^(?:tell|ping|notify)\s+me\s+when\s+(?:the\s+)?(.+?)(?:\s+thread)?\s+(?:is\s+done|finishes|asks).*$"#),
           let t = threadMatch(m[0]) {
            return [.watch(thread: t["id"].text, name: t["name"].text)] + askAssistant(s)
        }
        return askAssistant(s)
    }

    private func askAssistant(_ s: String) -> [Action] {
        guard let a = assistant else { return [] }
        return [.ask(agent: a, text: s, assistant: true)]
    }

    // MARK: running it

    private func run(_ a: Action?) async {
        guard let a, !busy else { return }
        if case .fill(let s) = a { q = s; return }
        busy = true
        defer { busy = false }
        problem = nil
        do {
            switch a {
            case .ask(let agent, let text, _):
                let out = try await app.call("agents.ask", ["agent": .string(agent), "text": .string(text), "surface": "ios", "wait": false])
                if out["ok"].bool == false { problem = out["note"].string ?? "\(agent) did not take it."; return }
                done = Done(text: "Sent to \(agent). The answer streams into the session.", thread: out["thread"].string)
            case .start(let project, let name, let text):
                let rec = try await app.call("threads.start", ["project": .string(project), "prompt": .string(text), "surface": "ios"])
                done = Done(text: "Started a session in \(name).", thread: rec["id"].string)
            case .send(let thread, let name, let text):
                let out = try await app.call("threads.send", ["thread": .string(thread), "text": .string(text), "surface": "ios"])
                if out["sent"].bool == true { done = Done(text: "Told \(name).", thread: thread) }
                else { problem = out["note"].string ?? "\(name) did not take it." ; return }
            case .watch(let thread, let name):
                _ = try await app.call("threads.watch", ["thread": .string(thread), "until": "either", "notify": "ios", "note": .string("Watch \(name)")])
                done = Done(text: "Watching \(name). You will get a notification when it finishes or asks.", thread: thread)
            case .fill: return
            }
            Haptics.success()
            q = ""
            hits = []
        } catch where isCancel(error) {
        } catch { problem = describe(error) }
    }

    private func loadCatalog() async {
        if let a = try? await app.call("agents.list") { agents = a.list; app.cache.put("agents.list", a) }
        else if let c = app.cache.get("agents.list") { agents = c.list }
        if let p = try? await app.call("projects.list") { projects = p["projects"].list }
        else if let c = app.cache.get("projects.list") { projects = c["projects"].list }
    }

    /// Recall hits for plain words, debounced by the task restarting on each keystroke.
    private func search() async {
        let s = q.trimmingCharacters(in: .whitespacesAndNewlines)
        guard s.count >= 3, !s.hasPrefix("@") else { hits = []; return }
        try? await Task.sleep(for: .milliseconds(350))
        if Task.isCancelled { return }
        if let out = try? await app.call("recall.search", ["q": .string(s), "limit": 5, "per_session": 1]), !Task.isCancelled {
            hits = out.list
        }
    }
}
