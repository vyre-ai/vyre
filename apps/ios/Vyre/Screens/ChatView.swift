import SwiftUI

enum ChatDest: Hashable {
    case project(slug: String, name: String)
    case thread(String)
}

/// Chat: live threads, then projects and their sessions, then one thread mirrored with streaming,
/// sending and the keyboard lease. The Deck's views/projects.js and deck/chat/.
struct ChatHome: View {
    @Environment(AppModel.self) private var app
    @State private var path: [ChatDest] = []
    @State private var projects: [JSON] = []
    @State private var loading = true
    @State private var problem: String?
    @State private var cached = false
    @State private var starting = false

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.xl) {
                    HStack(alignment: .top) {
                        PageHead(eyebrow: "Chat", title: "Sessions", sub: cached ? "Offline. The projects this phone kept." : nil)
                        Spacer()
                        Button { starting = true } label: { Label("New", systemImage: "plus") }
                            .buttonStyle(.secondary)
                            .padding(.top, Space.m)
                            .disabled(projects.isEmpty && !app.online)
                    }
                    liveSection
                    projectSection
                }
                .padding(.horizontal, Space.gutter)
                .padding(.bottom, Space.xxl)
            }
            .refreshable { await load() }
            .vyreGround()
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: ChatDest.self) { dest in
                switch dest {
                case .project(let slug, let name): ProjectView(slug: slug, name: name, path: $path)
                case .thread(let id): ThreadView(id: id)
                }
            }
        }
        .sheet(isPresented: $starting) {
            NewThreadSheet(projects: projects) { id in
                starting = false
                if let id { path.append(.thread(id)) }
            }
        }
        .task { await load() }
        .onChange(of: app.route, initial: true) { _, r in
            if case .thread(let id) = r {
                path = [.thread(id)]
                app.route = nil
            }
        }
    }

    private var live: [JSON] {
        app.needs.threads.sorted { ($0["last"].double ?? 0) > ($1["last"].double ?? 0) }
    }

    @ViewBuilder
    private var liveSection: some View {
        if !live.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                SectionHead(title: "Today", note: "\(live.count)").padding(.bottom, Space.s)
                Hairline()
                ForEach(live.prefix(12), id: \.self) { t in
                    NavigationLink(value: ChatDest.thread(t["id"].text)) {
                        ListRow(title: t["name"].string ?? t["id"].text,
                                detail: [t["agent"].string, t["project"].string].compactMap { $0 }.joined(separator: " · "),
                                note: [t["status"].string, age(t["last"].double)].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "),
                                dot: statusDot(t["status"].string, asks: t["asks"].int ?? 0))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private var projectSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionHead(title: "Projects", note: projects.isEmpty ? nil : "\(projects.count)").padding(.bottom, Space.s)
            Hairline()
            LoadState(loading: loading && projects.isEmpty, problem: projects.isEmpty ? problem : nil,
                      empty: projects.isEmpty ? "No projects yet. A project is a folder the box knows; add one with vyre projects add." : nil)
            ForEach(projects, id: \.self) { p in
                NavigationLink(value: ChatDest.project(slug: p["slug"].text, name: p["name"].string ?? p["slug"].text)) {
                    ListRow(title: p["name"].string ?? p["slug"].text,
                            detail: p["org"].string,
                            note: [p["threads"].int.map { plural($0, "session") }, age(p["last"].double)].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            let out = try await app.call("projects.list")
            app.cache.put("projects.list", out)
            projects = out["projects"].list.sorted { ($0["last"].double ?? 0) > ($1["last"].double ?? 0) }
            problem = nil
            cached = false
        } catch {
            if let c = app.cache.get("projects.list") {
                projects = c["projects"].list
                cached = true
            }
            problem = describe(error)
        }
    }
}

/// One project's sessions: picked and in its folders (`projects.threads`).
struct ProjectView: View {
    @Environment(AppModel.self) private var app
    let slug: String
    let name: String
    @Binding var path: [ChatDest]
    @State private var sessions: [JSON] = []
    @State private var loading = true
    @State private var problem: String?
    @State private var starting = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.l) {
                PageHead(eyebrow: "Project", title: name)
                VStack(alignment: .leading, spacing: 0) {
                    SectionHead(title: "Sessions", note: sessions.isEmpty ? nil : "\(sessions.count)").padding(.bottom, Space.s)
                    Hairline()
                    LoadState(loading: loading && sessions.isEmpty, problem: problem, empty: sessions.isEmpty ? "No sessions in this project yet." : nil)
                    ForEach(sessions, id: \.self) { s in
                        Button { path.append(.thread(s["id"].text)) } label: {
                            ListRow(title: s["title"].string ?? s["name"].string ?? s["label"].string ?? s["id"].text,
                                    detail: s["missing"].bool == true ? "This session's transcript is gone." : s["cwd"].string,
                                    note: [s["turns"].int.map { plural($0, "turn") }, age(s["last"].double)].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                        }
                        .buttonStyle(.plain)
                        .disabled(s["missing"].bool == true)
                    }
                }
            }
            .padding(.horizontal, Space.gutter)
            .padding(.bottom, Space.xxl)
        }
        .refreshable { await load() }
        .vyreGround()
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { starting = true } label: { Image(systemName: "plus") }.accessibilityLabel("New session in \(name)")
            }
        }
        .vyreNavBar()
        .sheet(isPresented: $starting) {
            NewThreadSheet(projects: [["slug": .string(slug), "name": .string(name)]]) { id in
                starting = false
                if let id { path.append(.thread(id)) }
            }
        }
        .task { await load() }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            let out = try await app.call("projects.threads", ["project": .string(slug), "limit": 100])
            sessions = out.list.sorted { ($0["last"].double ?? 0) > ($1["last"].double ?? 0) }
            problem = nil
        } catch { problem = describe(error) }
    }
}

/// Start a session: a project and the first words (`threads.start {project, prompt, surface:"ios"}`).
struct NewThreadSheet: View {
    @Environment(AppModel.self) private var app
    let projects: [JSON]
    let done: (String?) -> Void
    @State private var project = ""
    @State private var prompt = ""
    @State private var busy = false
    @State private var problem: String?

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: Space.l) {
                if projects.count > 1 {
                    VStack(alignment: .leading, spacing: Space.s) {
                        Engraved("Project")
                        Picker("Project", selection: $project) {
                            ForEach(projects, id: \.self) { p in Text(p["name"].string ?? p["slug"].text).tag(p["slug"].text) }
                        }
                        .pickerStyle(.menu)
                        .tint(Color.bone)
                    }
                }
                VStack(alignment: .leading, spacing: Space.s) {
                    Engraved("First message")
                    TextField("", text: $prompt, prompt: Text("Draft the Northwind Bakery invoice reminder").foregroundStyle(Color.ash), axis: .vertical)
                        .vyre(.body)
                        .foregroundStyle(Color.bone)
                        .lineLimit(3...8)
                        .padding(Space.m)
                        .background(Color.panel, in: RoundedRectangle(cornerRadius: Radius.button))
                        .overlay { RoundedRectangle(cornerRadius: Radius.button).strokeBorder(Color.ruleStrong, lineWidth: 1) }
                }
                if let problem { FailedLine(text: problem) }
                Button { Task { await start() } } label: { Text(busy ? "Starting" : "Start") }
                    .buttonStyle(.vyre(.primary, fill: true))
                    .disabled(busy || project.isEmpty || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Spacer()
            }
            .padding(Space.gutter)
            .vyreGround()
            .navigationTitle("New session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { done(nil) } } }
            .vyreNavBar()
        }
        .onAppear { if project.isEmpty { project = projects.first?["slug"].string ?? "" } }
        .presentationDetents([.medium, .large])
    }

    private func start() async {
        busy = true
        defer { busy = false }
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let rec = try await app.call("threads.start", ["project": .string(project), "prompt": .string(text), "surface": "ios"])
            await app.needs.refresh()
            done(rec["id"].string)
        } catch { problem = describe(error) }
    }
}

/// One thread: the transcript mirrored, live while the app is in front, and the composer.
struct ThreadView: View {
    @Environment(AppModel.self) private var app
    let id: String
    @State private var transcript = Transcript()
    @State private var record: JSON = .null
    @State private var loaded = false
    @State private var recorded = false
    @State private var offlineCopy = false
    @State private var problem: String?
    @State private var holder: String?
    @State private var token: UUID?
    @State private var buffer: [VyreEvent] = []
    @State private var text = ""
    @State private var note: String?
    @State private var sending = false
    @State private var retryText: String?
    @FocusState private var focused: Bool

    static let surface = "ios"

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: Space.m) {
                        head
                        if !loaded && problem == nil { LoadState(loading: true, problem: nil, empty: nil) }
                        if let problem { FailedLine(text: problem) }
                        if loaded && transcript.entries.isEmpty { EmptyLine(text: recorded ? "This session has no turns to show." : "Nothing said yet.") }
                        ForEach(transcript.entries) { entry in row(entry) }
                        if transcript.working {
                            HStack(spacing: Space.s) { Dot(color: .signal); Engraved("Working", color: .signal) }
                        }
                        Color.clear.frame(height: 1).id("end")
                    }
                    .padding(.horizontal, Space.gutter)
                    .padding(.bottom, Space.m)
                }
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: transcript) { _, _ in withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo("end", anchor: .bottom) } }
                .onChange(of: loaded) { _, _ in proxy.scrollTo("end", anchor: .bottom) }
            }
            composer
        }
        .vyreGround()
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 0) {
                    Text(title).vyre(.title).foregroundStyle(Color.bone).lineLimit(1)
                    if let s = record["status"].string { Engraved(s) }
                }
            }
            ToolbarItem(placement: .topBarTrailing) { menu }
        }
        .vyreNavBar()
        .task { await load() }
        .onAppear { listen() }
        .onDisappear {
            app.hub.off(token)
            token = nil
            if focused || holder == ThreadView.surface { Task { await release() } }
        }
        .onChange(of: focused) { _, f in
            if f { Task { await lease() } } else if holder == ThreadView.surface { Task { await release() } }
        }
        // The lease lives 90 s: renew it every 60 s while the composer is focused and the app is in front.
        .task(id: focused && app.inFront) {
            guard focused && app.inFront else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(60))
                if Task.isCancelled || !focused { break }
                await lease()
            }
        }
    }

    private var title: String { record["name"].string ?? (recorded ? "Recorded session" : "Session") }

    private var head: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            let bits = [record["agent"].string, record["project"].string, record["model"].string].compactMap { $0 }
            if !bits.isEmpty { Text(bits.joined(separator: " · ")).vyre(.codeSmall).foregroundStyle(Color.ash) }
            if offlineCopy { Engraved("Offline copy") }
            if recorded { Text("Recorded. Nothing is running it; a message resumes it if the box can.").vyre(.small).foregroundStyle(Color.stone) }
        }
        .padding(.top, Space.s)
    }

    private var menu: some View {
        Menu {
            Button { Task { await watch() } } label: { Label("Tell me when it finishes", systemImage: "bell") }
            if record["status"].string != "stopped" && !recorded {
                Button(role: .destructive) { Task { await stop() } } label: { Label("Stop", systemImage: "stop") }
            }
            Button { Task { await load() } } label: { Label("Reload", systemImage: "arrow.clockwise") }
        } label: { Image(systemName: "ellipsis.circle") }
        .accessibilityLabel("Thread actions")
    }

    // MARK: rows

    @ViewBuilder
    private func row(_ entry: Transcript.Entry) -> some View {
        switch entry {
        case .said(_, let t, let surface):
            VStack(alignment: .leading, spacing: Space.xs) {
                Engraved(who(surface))
                Text(t).vyre(.body).foregroundStyle(Color.bone).textSelection(.enabled)
            }
            .padding(Space.m)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.panel, in: RoundedRectangle(cornerRadius: Radius.panel))
        case .reply(_, let t, let done):
            Text(markdown(t) + (done ? "" : " ")).vyre(.body).foregroundStyle(Color.bone)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .notice(_, let t):
            HStack(alignment: .firstTextBaseline, spacing: Space.s) { Engraved("vyre"); Text(t).vyre(.small).foregroundStyle(Color.stone) }
        case .tools(_, let lines):
            VStack(alignment: .leading, spacing: Space.xs) {
                ForEach(lines.suffix(8)) { l in
                    HStack(alignment: .firstTextBaseline, spacing: Space.s) {
                        Dot(color: l.phase == "started" ? .signal : .ash)
                        Text(l.error ? "failed" : l.phase == "started" ? "running" : "done").vyre(.label).foregroundStyle(Color.ash).frame(width: 60, alignment: .leading)
                        Text(l.summary.isEmpty ? l.tool : l.summary).vyre(.codeSmall).foregroundStyle(Color.stone).lineLimit(2)
                    }
                }
                if lines.count > 8 { Engraved("and \(lines.count - 8) more") }
            }
            .padding(Space.m)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.codeGround, in: RoundedRectangle(cornerRadius: Radius.button))
        case .finished(_, let t):
            HStack(spacing: Space.s) { Hairline(); Engraved(t.isEmpty ? "turn done" : "turn done · \(t)").fixedSize(); Hairline() }
        case .stopped(_, let r):
            HStack(spacing: Space.s) { Hairline(); Engraved("stopped · \(r)").fixedSize(); Hairline() }
        case .gate(let gid):
            if let d = app.needs.held.first(where: { $0.id == gid }) {
                VStack(alignment: .leading, spacing: Space.s) {
                    HStack(spacing: Space.s) { Dot(color: .beacon); Engraved("Held before it went out", color: .beacon) }
                    Text(d.title).vyre(.title).foregroundStyle(Color.bone)
                    HeldBody(draft: d, compact: true)
                }
                .padding(Space.gutter)
                .background(Color.beaconWash, in: RoundedRectangle(cornerRadius: Radius.panel))
                .id("held-\(d.id)-\(d.error ?? "")")
            } else {
                Engraved("A draft was held here. It is no longer waiting.")
            }
        case .ask(let aid):
            if let a = app.needs.asks.first(where: { $0.id == aid }) { AskCard(ask: a) }
            else { Engraved("A permission was asked here. It was answered.") }
        }
    }

    private func who(_ surface: String?) -> String {
        guard let s = surface else { return "Typed" }
        if s == ThreadView.surface { return "You, this phone" }
        if s.hasPrefix("agent:") { return String(s.dropFirst(6)) }
        if s.hasPrefix("tailnet:") { return "You, another device" }
        return "You, \(s)"
    }

    private func markdown(_ t: String) -> AttributedString {
        (try? AttributedString(markdown: t, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(t)
    }

    // MARK: composer

    private var composer: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            if let h = holder, h != ThreadView.surface, !focused {
                Text("\(holderName(h)) has the keyboard. Typing here takes it.").vyre(.small).foregroundStyle(Color.stone)
            }
            if let note {
                HStack(alignment: .firstTextBaseline) {
                    Text(note).vyre(.small).foregroundStyle(Color.stone)
                    Spacer()
                    if retryText != nil { Button("Take it and send") { Task { await takeAndSend() } }.buttonStyle(.quiet) }
                }
            }
            HStack(alignment: .bottom, spacing: Space.s) {
                TextField("", text: $text, prompt: Text(recorded ? "Resume with a message" : "Message").foregroundStyle(Color.ash), axis: .vertical)
                    .vyre(.body)
                    .foregroundStyle(Color.bone)
                    .lineLimit(1...6)
                    .focused($focused)
                    .padding(.horizontal, Space.m)
                    .padding(.vertical, 10)
                    .background(Color.ground, in: RoundedRectangle(cornerRadius: Radius.button))
                    .overlay {
                        RoundedRectangle(cornerRadius: Radius.button).strokeBorder(focused ? Color.signal : Color.ruleStrong, lineWidth: focused ? 2 : 1)
                    }
                Button { Task { await send() } } label: { Image(systemName: "arrow.up") }
                    .buttonStyle(.vyre(.primary))
                    .disabled(sending || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityLabel("Send")
            }
        }
        .padding(.horizontal, Space.gutter)
        .padding(.vertical, Space.s)
        .background(Color.panel)
        .overlay(alignment: .top) { Hairline() }
    }

    private func holderName(_ h: String) -> String {
        switch h {
        case "deck": "The Deck"
        case "capsule": "The Capsule"
        case "android": "Your Android phone"
        default: h.hasPrefix("tailnet:") ? "Another device" : h.hasPrefix("agent:") ? String(h.dropFirst(6)) : h
        }
    }

    // MARK: actions

    private func listen() {
        guard token == nil else { return }
        token = app.hub.on { e in
            guard e.thread == id else { return }
            if loaded { take(e) } else { buffer.append(e) }
        }
    }

    private func take(_ e: VyreEvent) {
        transcript.apply(e)
        switch e.type {
        case "lease.changed": holder = e["holder"].string
        case "thread.started": record = record.with("status", "working")
        case "thread.sent": record = record.with("status", "working")
        case "thread.finished": record = record.with("status", "idle")
        case "thread.stopped": record = record.with("status", "stopped")
        case "ask.raised": record = record.with("status", "waiting")
        default: break
        }
    }

    private func load() async {
        problem = nil
        do {
            let out = try await app.call("threads.get", ["thread": .string(id), "limit": 400])
            app.cache.putThread(id, out)
            show(out, offline: false)
        } catch {
            if let c = app.cache.thread(id) {
                show(c, offline: true)
                return
            }
            // No live thread: a recorded session, read from recall.
            do {
                let out = try await app.call("recall.thread", ["session": .string(id), "limit": 400])
                var t = Transcript()
                t.load(turns: out["turns"].list)
                transcript = t
                let s = out["session"]
                record = ["name": JSON(s["title"].string ?? s["name"].string)]
                recorded = true
                loaded = true
            } catch {
                problem = describe(error)
                loaded = true
            }
        }
    }

    private func show(_ out: JSON, offline: Bool) {
        var t = Transcript()
        for j in out["events"].list { if let e = VyreEvent(j) { t.apply(e) } }
        for a in out["asks"].list where a["state"].string == "open" { t.apply(VyreEvent(id: 0, at: 0, type: "ask.raised", payload: ["ask": a["id"]])) }
        let rec = out["thread"]
        t.working = ["working", "starting"].contains(rec["status"].string ?? "")
        transcript = t
        record = rec
        holder = rec["holder"].string
        offlineCopy = offline
        recorded = false
        loaded = true
        for e in buffer { take(e) }
        buffer = []
    }

    private func lease() async {
        guard !recorded else { return }
        if let out = try? await app.call("threads.lease", ["thread": .string(id), "surface": .string(ThreadView.surface)]) {
            holder = out["holder"].string
        }
    }

    private func release() async {
        if let out = try? await app.call("threads.release", ["thread": .string(id), "surface": .string(ThreadView.surface)]) {
            holder = out["holder"].string
        }
    }

    private func send() async {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        sending = true
        defer { sending = false }
        note = nil
        retryText = nil
        do {
            let out = try await app.call("threads.send", ["thread": .string(id), "text": .string(t), "surface": .string(ThreadView.surface)])
            if out["sent"].bool == true {
                text = ""
                transcript.echo(t)
                holder = ThreadView.surface
            } else if out["open_elsewhere"].bool == true {
                note = out["note"].string ?? "This session is open in a terminal. Type there, or close it first."
            } else {
                note = out["note"].string ?? "\(holderName(out["holder"].text)) has the keyboard."
                retryText = t
            }
        } catch { note = describe(error) }
    }

    private func takeAndSend() async {
        await lease()
        await send()
    }

    private func stop() async {
        do {
            let out = try await app.call("threads.stop", ["thread": .string(id)])
            if out["stopped"].bool != true { note = out["note"].string ?? "It was not running." }
        } catch { note = describe(error) }
    }

    private func watch() async {
        do {
            _ = try await app.call("threads.watch", ["thread": .string(id), "until": "either", "notify": .string(ThreadView.surface), "note": .string(title)])
            note = "You will get a notification when it finishes or asks."
        } catch { note = describe(error) }
    }
}
