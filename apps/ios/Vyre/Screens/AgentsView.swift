import SwiftUI

/// Agents (a page; phone.md section 8): "1 working, 1 idle", then a card for each working agent
/// with its live console (subscribed only while this page is on screen, at most 4 new lines a
/// second), its step, Watch and Pause, and the projects it may work in; a row for each idle agent;
/// and Scheduled, when the box lists schedules. "+" in the header makes a new agent (no Face ID).
/// Events drive it; a 60 s fallback while on screen, none while the app is in the background.
struct AgentsHome: View {
    @Environment(AppModel.self) private var app
    @State private var agents: [JSON] = []
    @State private var projects: [JSON] = []
    @State private var loading = true
    @State private var problem: String?
    @State private var cached = false
    @State private var token: UUID?
    @State private var live: UUID?
    /// Per working thread: its console, and its step count since the turn began.
    @State private var consoles: [String: Console] = [:]
    @State private var steps: [String: Int] = [:]
    @State private var flushing: Set<String> = []
    @State private var note: String?
    @State private var tick = Date()

    var body: some View {
        let working = agents.filter(isWorking)
        let idle = agents.filter { !isWorking($0) }
        PullScroll {
            VStack(alignment: .leading, spacing: Space.m) {
                if !agents.isEmpty {
                    Text("\(working.count) working, \(idle.count) idle").vyre(.secondary).foregroundStyle(Color.label)
                }
                if cached { EmptyLine(text: "Offline. The list this phone kept.") }
                if let note { Text(note).vyre(.small).foregroundStyle(Color.text2) }
                if agents.isEmpty {
                    LoadState(loading: loading, problem: problem, empty: nil)
                    if !loading && problem == nil {
                        Text("Only \(app.assistantLabel) so far.").vyre(.secondary).foregroundStyle(Color.label)
                        Button("New agent") { app.sheet = .newAgent }.buttonStyle(.secondary)
                    }
                }
                ForEach(working, id: \.self) { a in
                    WorkingCard(agent: a, session: session(a), console: consoles[a["thread"].text] ?? Console(), step: steps[a["thread"].text],
                                projects: projectNames(a), now: tick,
                                watch: { app.path.append(.watch(a["thread"].text)) },
                                pause: { Task { await pause(a) } })
                }
                if !idle.isEmpty {
                    Card {
                        ForEach(Array(idle.enumerated()), id: \.offset) { i, a in
                            if i > 0 { Hairline() }
                            Button { app.path.append(.agent(a["name"].text)) } label: { IdleRow(agent: a, projects: projectNames(a)) }
                                .buttonStyle(.plain)
                        }
                    }
                }
                scheduled
            }
            .padding(.horizontal, Space.gutter)
            .padding(.top, Space.s)
            .padding(.bottom, Space.xxl)
        }
        .vyreGround()
        .task(id: app.agentsVersion) { await load() }
        .onAppear {
            guard token == nil else { return }
            let watched: Set<String> = ["thread.started", "thread.finished", "thread.stopped", "ask.raised", "ask.answered"]
            token = app.hub.on { e in if watched.contains(e.type) { Task { await load() } } }
        }
        .onChange(of: onScreen, initial: true) { _, on in
            if on { subscribe() } else { unsubscribe() }
        }
        .onDisappear { unsubscribe() }
        .task(id: onScreen) {
            // The elapsed times move every 5 s, and a fallback read runs every 60 s, only while this
            // page is on screen.
            var n = 0
            while onScreen && !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                if Task.isCancelled || !onScreen { break }
                n += 1
                tick = Date()
                if n % 12 == 0 { await load() }
            }
        }
    }

    /// Agents is in front: the page, nothing pushed over it, the app on screen.
    private var onScreen: Bool { app.page == .agents && app.path.isEmpty && app.sheet == nil && app.inFront }

    private func isWorking(_ a: JSON) -> Bool {
        ["working", "starting", "waiting"].contains(a["status"].string ?? "") && a["thread"].string != nil
    }

    private func session(_ a: JSON) -> String {
        let t = a["thread"].text
        if let rec = app.needs.threads.first(where: { $0["id"].string == t }) { return threadLabel(rec) }
        return String(t.prefix(8))
    }

    private func projectNames(_ a: JSON) -> [String] {
        if a["projects"].string == "*" || a["kind"].string == "assistant" { return [] }
        return a["projects"].strings.map { slug in projects.first { $0["slug"].string == slug }?["name"].string ?? slug }
    }

    @ViewBuilder
    private var scheduled: some View {
        // The box does not list agents' schedules yet; an agent that carries `schedule` shows here.
        let jobs: [(agent: String, job: JSON)] = agents.flatMap { a in a["schedule"].list.map { (agent: a["name"].text, job: $0) } }
        if !jobs.isEmpty {
            Text("Scheduled").vyre(.title).foregroundStyle(Color.text).padding(.top, Space.m)
            Card {
                ForEach(Array(jobs.enumerated()), id: \.offset) { i, j in
                    if i > 0 { Hairline() }
                    HStack(alignment: .top, spacing: Space.m) {
                        Image(systemName: "clock").font(.system(size: 20)).foregroundStyle(Color.label).frame(width: 22)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(j.job["job"].string ?? j.job["title"].text).vyre(.body).foregroundStyle(Color.text)
                            Text([j.agent, j.job["cadence"].string].compactMap { $0 }.joined(separator: " · ")).vyre(.small).foregroundStyle(Color.label)
                        }
                        Spacer(minLength: Space.s)
                        if let at = j.job["next"].double { Text(inTime(at)).vyre(.small).foregroundStyle(Color.label) }
                    }
                    .padding(.vertical, 12).padding(.horizontal, 14)
                }
            }
        }
    }

    /// "in 14h", "in 20 min".
    private func inTime(_ ms: Double) -> String {
        let s = Int((ms - Date().timeIntervalSince1970 * 1000) / 1000)
        if s <= 60 { return "now" }
        if s < 3600 { return "in \(s / 60) min" }
        if s < 86_400 { return "in \(s / 3600)h" }
        return "in \(s / 86_400)d"
    }

    // MARK: live

    /// The consoles follow the working agents' threads while the page is on screen, and only then.
    private func subscribe() {
        guard live == nil else { return }
        live = app.hub.on { e in
            guard let t = e.thread, agents.contains(where: { $0["thread"].string == t && isWorking($0) }) else { return }
            if e.type == "thread.started" { steps[t] = 0 }
            if e.type == "thread.tool", e["phase"].string == "started" { steps[t, default: 0] += 1 }
            guard let l = Console.line(e) else { return }
            var c = consoles[t] ?? Console()
            let held = c.offer(l.text, command: l.command, now: Date())
            consoles[t] = c
            if held { flushLater(t) }
        }
    }

    private func unsubscribe() {
        app.hub.off(live)
        live = nil
    }

    private func flushLater(_ t: String) {
        guard !flushing.contains(t) else { return }
        flushing.insert(t)
        Task {
            try? await Task.sleep(for: .seconds(Console.interval))
            flushing.remove(t)
            guard var c = consoles[t] else { return }
            c.flush(now: Date())
            consoles[t] = c
            if c.held != nil { flushLater(t) }
        }
    }

    // MARK: loading

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            let out = try await app.call("agents.list")
            app.cache.put("agents.list", out)
            agents = out.list
            cached = false
            problem = nil
        } catch {
            if let c = app.cache.get("agents.list") { agents = c.list; cached = true }
            problem = describe(error)
        }
        if projects.isEmpty {
            if let p = try? await app.call("projects.list") { projects = p["projects"].list }
            else if let c = app.cache.get("projects.list") { projects = c["projects"].list }
        }
        // A working agent's console and step start from its thread's recent events.
        for a in agents.filter(isWorking) {
            let t = a["thread"].text
            guard consoles[t] == nil, let out = try? await app.call("threads.get", ["thread": .string(t), "limit": 60]) else { continue }
            var c = Console()
            var n = 0
            for j in out["events"].list {
                guard let e = VyreEvent(j) else { continue }
                if e.type == "thread.started" { n = 0 }
                if e.type == "thread.tool", e["phase"].string == "started" { n += 1 }
                if let l = Console.line(e) { c.append(l.text, command: l.command) }
            }
            consoles[t] = c
            steps[t] = n
        }
    }

    /// Pause: stop the agent's thread. Its transcript stays; a message resumes it.
    private func pause(_ a: JSON) async {
        do {
            let out = try await app.call("threads.stop", ["thread": .string(a["thread"].text)])
            note = out["stopped"].bool == true ? "Paused \(a["name"].text). A message resumes it." : (out["note"].string ?? "It was not running.")
            await load()
        } catch { note = describe(error) }
    }
}

/// A working agent (phone.md section 8): its tile and name, "Working on <session>" with the
/// elapsed time, the last 3 console lines with a block caret, its step, Watch and Pause, and the
/// projects it may work in. The box gives no step total yet, so the step shows without a bar.
struct WorkingCard: View {
    let agent: JSON
    let session: String
    let console: Console
    let step: Int?
    let projects: [String]
    let now: Date
    let watch: () -> Void
    let pause: () -> Void

    var body: some View {
        let name = agent["name"].text
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: Space.m) {
                Tile(name: name, size: 40)
                VStack(alignment: .leading, spacing: 2) {
                    Text(name).vyre(.title).foregroundStyle(Color.text)
                    HStack(spacing: 6) {
                        Circle().fill(Color.text).frame(width: 7, height: 7)
                            .padding(3).overlay { Circle().strokeBorder(Color.rule, lineWidth: 3) }
                            .accessibilityHidden(true)
                        Text(agent["status"].string == "waiting" ? "Waiting on you in \(session)" : "Working on \(session)")
                            .vyre(.small).foregroundStyle(agent["status"].string == "waiting" ? Color.beaconInk : Color.text2).lineLimit(1)
                    }
                }
                Spacer(minLength: Space.s)
                Text(elapsed).font(VyreFonts.base(.commandRow).asFont(size: 13)).foregroundStyle(Color.label)
            }
            ConsoleBox(lines: Array(console.lines.suffix(3)), caret: true)
            if let step, step > 0 {
                // Step n of m and a bar need the box to say how many steps there are; it does not yet.
                Text("Step \(step)").vyre(.small).foregroundStyle(Color.text2)
            }
            HStack(spacing: Space.s) {
                Button(action: watch) { Label("Watch", systemImage: "eye") }
                    .buttonStyle(.vyre(.secondary, fill: true))
                Button(action: pause) { Label("Pause", systemImage: "pause") }
                    .buttonStyle(.vyre(.secondary, fill: true))
            }
            if !projects.isEmpty {
                FlowLayout(spacing: 6) {
                    ForEach(projects, id: \.self) { p in
                        Text(p).vyre(.small).foregroundStyle(Color.text2)
                            .padding(.vertical, 3).padding(.horizontal, Space.s)
                            .overlay { RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Color.ruleStrong, lineWidth: 1) }
                    }
                }
            }
        }
        .padding(14)
        .background(Color.panel, in: RoundedRectangle(cornerRadius: Radius.card))
        .overlay { RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Color.rule, lineWidth: 1) }
    }

    private var elapsed: String {
        guard let started = agent["started"].double ?? agent["since"].double else { return "" }
        let s = max(0, Int(now.timeIntervalSince1970 - started / 1000))
        return s >= 3600 ? String(format: "%d:%02d:%02d", s / 3600, s / 60 % 60, s % 60) : String(format: "%02d:%02d", s / 60, s % 60)
    }
}

/// The console box: `--code-bg` (`--bg` on paper), `--rule` border, radius 8, 10 x 12, mono
/// 12/19 in `--text-2`; a command with `$` in `--label`; a block caret on the last line.
struct ConsoleBox: View {
    let lines: [Console.Line]
    var caret = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if lines.isEmpty {
                Text(caret ? "\u{2588}" : " ").vyre(.codeSmall).foregroundStyle(Color.label)
            }
            ForEach(Array(lines.enumerated()), id: \.element.id) { i, l in
                let last = i == lines.count - 1
                (Text(l.command ? "$ " : "").foregroundStyle(Color.label)
                 + Text(l.text).foregroundStyle(Color.text2)
                 + Text(caret && last ? " \u{2588}" : "").foregroundStyle(Color.label))
                    .vyre(.codeSmall)
                    .lineLimit(caret ? 1 : nil)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.blockBg, in: RoundedRectangle(cornerRadius: Radius.tile))
        .overlay { RoundedRectangle(cornerRadius: Radius.tile).strokeBorder(Color.rule, lineWidth: 1) }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(lines.isEmpty ? "Console, nothing yet" : "Console: " + lines.map(\.text).joined(separator: ". "))
    }
}

/// An idle agent: its tile, its name with a role tag, what it sees, a chevron.
struct IdleRow: View {
    let agent: JSON
    let projects: [String]

    var body: some View {
        let name = agent["name"].text
        HStack(spacing: Space.m) {
            Tile(name: name, size: 40)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: Space.s) {
                    Text(name).vyre(.title).foregroundStyle(Color.text)
                    Text(agent["kind"].string == "assistant" ? "Assistant" : "Agent").vyre(.micro).foregroundStyle(Color.text2)
                        .padding(.vertical, 1).padding(.horizontal, 6)
                        .overlay { RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Color.ruleStrong, lineWidth: 1) }
                }
                Text(line).vyre(.small).foregroundStyle(Color.label).lineLimit(1)
            }
            Spacer(minLength: Space.s)
            Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(Color.label)
        }
        .padding(.vertical, 12).padding(.horizontal, 14)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private var line: String {
        let state: String
        switch agent["status"].string {
        case "stopped": state = "Paused"
        case "new": state = "Not started"
        default: state = "Idle"
        }
        let sees: String
        if agent["projects"].string == "*" || agent["kind"].string == "assistant" { sees = "sees every project" }
        else if projects.count == 1 { sees = "works in \(projects[0])" }
        else { sees = "works in \(projects.count) projects" }
        return "\(state) · \(sees)"
    }
}

/// Watch (phone.md section 8): an agent's session live, pushed. The full console, scrollable, the
/// session's tool rows, and the same approval card when it asks. Subscribed only while on screen.
struct AgentLiveView: View {
    @Environment(AppModel.self) private var app
    let thread: String
    @State private var transcript = Transcript()
    @State private var console = Console()
    @State private var record: JSON = .null
    @State private var token: UUID?
    @State private var flushing = false
    @State private var expanded: Set<String> = []
    @State private var problem: String?

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if let problem { FailedLine(text: problem) }
                    ConsoleBox(lines: console.lines, caret: transcript.working)
                    ForEach(transcript.entries.filter(\.isWork)) { entry in
                        switch entry {
                        case .tools(_, let lines):
                            ToolBox(lines: lines, running: transcript.working, expanded: $expanded, flashLine: nil, flashOn: false)
                        case .ask(let aid):
                            if let a = app.needs.asks.first(where: { $0.id == aid }) {
                                if a.isQuestion { QuestionCard(ask: a) } else { ApprovalCard(ask: a) }
                            }
                        case .gate(let gid):
                            if let d = app.needs.held.first(where: { $0.id == gid }) { HeldCard(draft: d) }
                        default: EmptyView()
                        }
                    }
                    Button { app.path.append(.thread(thread)) } label: {
                        HStack { Text("Open the whole session").vyre(.secondary, weight: 600); Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)) }
                            .foregroundStyle(Color.text).frame(minHeight: Space.target)
                    }
                    .buttonStyle(.plain)
                    Color.clear.frame(height: 1).id("end")
                }
                .padding(.horizontal, Space.gutter)
                .padding(.vertical, Space.m)
            }
            .onChange(of: console.lines.count) { _, _ in withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo("end", anchor: .bottom) } }
        }
        .vyreGround()
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 0) {
                    Text(record["agent"].string ?? app.assistantLabel).vyre(.title).foregroundStyle(Color.text).lineLimit(1)
                    Text(threadLabel(record.isNull ? ["id": .string(thread)] : record)).vyre(.micro).foregroundStyle(Color.label).lineLimit(1)
                }
            }
        }
        .vyreNavBar()
        .task { await load() }
        .onAppear { listen() }
        .onDisappear {
            app.hub.off(token)
            token = nil
        }
    }

    private func listen() {
        guard token == nil else { return }
        token = app.hub.on { e in
            guard e.thread == thread else { return }
            transcript.apply(e)
            if e.type == "thread.started" || e.type == "thread.sent" { transcript.working = true }
            if let l = Console.line(e), console.offer(l.text, command: l.command, now: Date()) { flushLater() }
        }
    }

    private func flushLater() {
        guard !flushing else { return }
        flushing = true
        Task {
            try? await Task.sleep(for: .seconds(Console.interval))
            flushing = false
            console.flush(now: Date())
            if console.held != nil { flushLater() }
        }
    }

    private func load() async {
        do {
            let out = try await app.call("threads.get", ["thread": .string(thread), "limit": 50])
            var t = Transcript()
            var c = Console()
            for j in out["events"].list {
                guard let e = VyreEvent(j) else { continue }
                t.apply(e)
                if let l = Console.line(e) { c.append(l.text, command: l.command) }
            }
            for a in out["asks"].list where (a["state"].string ?? "open") == "open" {
                t.apply(VyreEvent(id: 0, at: 0, type: "ask.raised", payload: ["ask": a["id"], "kind": a["kind"]]))
            }
            record = out["thread"]
            t.working = ["working", "starting"].contains(record["status"].string ?? "")
            transcript = t
            console = c
            problem = nil
        } catch { problem = describe(error) }
    }
}

extension Transcript.Entry {
    /// What the Watch view draws: tool rows, asks and held drafts.
    var isWork: Bool {
        switch self {
        case .tools, .ask, .gate: true
        default: false
        }
    }
}

/// One agent: what it is doing, its threads, what it was asked lately, and a line to ask it.
struct AgentDetailView: View {
    @Environment(AppModel.self) private var app
    let name: String
    @State private var agent: JSON = .null
    @State private var usage: JSON = .null
    @State private var history: [JSON] = []
    @State private var threads: [JSON] = []
    @State private var problem: String?
    @State private var ask = ""
    @State private var busy = false
    @State private var line: String?
    @State private var sentThread: String?

    var body: some View {
        PullScroll {
            VStack(alignment: .leading, spacing: Space.xl) {
                PageHead(eyebrow: agent["kind"].string == "assistant" ? "Assistant" : "Agent", title: name, sub: agent["doing"].string)
                facts
                askBox
                if let problem { FailedLine(text: problem) }
                threadList
                historyList
            }
            .padding(.horizontal, Space.gutter)
            .padding(.bottom, Space.xxl)
        }
        .vyreGround()
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if threads.contains(where: { $0["status"].string != "stopped" }) {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Stop") { Task { await stop() } }.accessibilityLabel("Stop \(name)'s threads")
                }
            }
        }
        .vyreNavBar()
        .task { await load() }
    }

    private var facts: some View {
        VStack(alignment: .leading, spacing: 0) {
            Hairline()
            pair("Model", modelLabel(agent["model"].string))
            pair("Paid by", agent["auth"].string)
            pair("Projects", agent["projects"].string == "*" ? "all" : agent["projects"].strings.joined(separator: ", "))
            pair("Computer", agent["computer"].bool == true ? "yes" : "no")
            if let c = usage["cost_usd"].double { pair("Spent", String(format: "$%.2f over %@", c, plural(usage["turns"].int ?? 0, "turn"))) }
            if let b = usage["budget_usd"].double, b > 0 { pair("Budget left", String(format: "$%.2f of $%.2f", usage["left_usd"].double ?? 0, b)) }
            if let l = usage["limit"].object, let s = l["status"]?.string { pair("Limit", s) }
        }
    }

    @ViewBuilder
    private func pair(_ k: String, _ v: String?) -> some View {
        if let v, !v.isEmpty {
            HStack(alignment: .firstTextBaseline, spacing: Space.m) {
                Engraved(k).frame(width: 96, alignment: .leading)
                Text(v).vyre(.code).foregroundStyle(Color.text)
                Spacer()
            }
            .padding(.vertical, Space.s)
            .overlay(alignment: .bottom) { Hairline() }
        }
    }

    private var askBox: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            HStack(spacing: Space.s) {
                SearchField(text: $ask, prompt: "Ask \(name)", icon: "bubble.left", submit: { Task { await send() } })
                Button { Task { await send() } } label: { Image(systemName: "arrow.up") }
                    .buttonStyle(.vyre(.primary))
                    .disabled(busy || ask.trimmingCharacters(in: .whitespaces).isEmpty)
                    .accessibilityLabel("Send to \(name)")
            }
            if let line {
                HStack {
                    Text(line).vyre(.small).foregroundStyle(Color.text2)
                    Spacer()
                    if let t = sentThread { Button("Open") { app.open(.thread(t)) }.buttonStyle(.quiet) }
                }
            }
        }
    }

    @ViewBuilder
    private var threadList: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionHead(title: "Threads", note: threads.isEmpty ? nil : "\(threads.count)").padding(.bottom, Space.s)
            Hairline()
            if threads.isEmpty { EmptyLine(text: "No threads in the last day.") }
            ForEach(threads, id: \.self) { t in
                Button { app.open(.thread(t["id"].text)) } label: {
                    ListRow(title: t["name"].string ?? t["id"].text, detail: t["project"].string,
                            note: [t["status"].string, age(t["last"].double)].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "),
                            dot: statusDot(t["status"].string, asks: t["asks"].int ?? 0))
                }
                .buttonStyle(.plain)
            }
        }
    }

    @ViewBuilder
    private var historyList: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionHead(title: "Asked lately").padding(.bottom, Space.s)
            Hairline()
            if history.isEmpty { EmptyLine(text: "Nobody has asked \(name) anything yet.") }
            ForEach(history.reversed(), id: \.self) { h in
                VStack(alignment: .leading, spacing: Space.xs) {
                    HStack {
                        Engraved(h["surface"].string ?? "asked")
                        Spacer()
                        Text(age(h["at"].double)).vyre(.codeSmall).foregroundStyle(Color.label)
                    }
                    Text(h["text"].text).vyre(.small).foregroundStyle(Color.text).lineLimit(3)
                    if let a = h["answer"].string, !a.isEmpty { Text(a).vyre(.small).foregroundStyle(Color.text2).lineLimit(4) }
                }
                .padding(.vertical, Space.m)
                .overlay(alignment: .bottom) { Hairline() }
            }
        }
    }

    private func load() async {
        do {
            let list = try await app.call("agents.list")
            agent = list.list.first { $0["name"].string == name } ?? .null
            problem = nil
        } catch {
            agent = app.cache.get("agents.list")?.list.first { $0["name"].string == name } ?? .null
            problem = describe(error)
        }
        async let u = try? app.call("agents.usage", ["agent": .string(name)])
        async let h = try? app.call("agents.history", ["agent": .string(name), "limit": 20])
        async let t = try? app.call("agents.threads", ["agent": .string(name)])
        let (uu, hh, tt) = await (u, h, t)
        usage = uu?.list.first { $0["agent"].string == name } ?? .null
        history = hh?.list ?? []
        threads = tt?.list ?? []
    }

    private func send() async {
        let text = ask.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        busy = true
        defer { busy = false }
        do {
            let out = try await app.call("agents.ask", ["agent": .string(name), "text": .string(text), "surface": "ios", "wait": false])
            if out["ok"].bool == false { line = out["note"].string ?? "\(name) did not take it."; sentThread = nil; return }
            ask = ""
            line = "Sent. The answer streams into the thread."
            sentThread = out["thread"].string
        } catch { line = describe(error) }
    }

    private func stop() async {
        do {
            let out = try await app.call("agents.stop", ["agent": .string(name)])
            line = "Stopped \(plural(out["stopped"].list.count, "thread"))."
            await load()
        } catch { line = describe(error) }
    }
}
