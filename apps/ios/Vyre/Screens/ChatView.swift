import SwiftUI

/// Chat (a tab): sessions and threads. Live ones first (running, starting, waiting), then the
/// others from the last day; each opens the thread, mirrored with streaming, sending and the
/// keyboard lease. The Deck's deck/chat/ and the Android ChatScreen.
struct ChatHome: View {
    @Environment(AppModel.self) private var app
    @State private var path: [Dest] = []
    @State private var all: [JSON] = []
    @State private var loading = true
    @State private var problem: String?
    @State private var projects: [JSON] = []
    @State private var starting = false
    @State private var token: UUID?

    var body: some View {
        NavigationStack(path: $path) {
            PullScroll {
                VStack(alignment: .leading, spacing: Space.xl) {
                    VStack(alignment: .leading, spacing: 0) {
                        BrandBar {
                            Button { starting = true } label: { Label("New", systemImage: "plus") }
                                .buttonStyle(.quiet)
                                .disabled(projects.isEmpty)
                        }
                        PageHead(title: "Chat")
                    }
                    section("Live", live, empty: "No session is running. Start one from a project.")
                    section("Sessions", rest, empty: "No session in the last day.")
                }
                .padding(.horizontal, Space.gutter)
                .padding(.bottom, Space.xxl)
            }
            .vyreGround()
            .toolbar(.hidden, for: .navigationBar)
            .vyreDestinations()
        }
        .sheet(isPresented: $starting) {
            NewThreadSheet(projects: projects) { id in
                starting = false
                if let id { path.append(.thread(id)) }
            }
        }
        .task { await load() }
        .onAppear {
            guard token == nil else { return }
            let watched: Set<String> = ["thread.started", "thread.finished", "thread.stopped", "ask.raised", "ask.answered"]
            token = app.hub.on { e in if watched.contains(e.type) { Task { await load() } } }
        }
        .onChange(of: app.route, initial: true) { _, r in
            if case .thread(let id) = r {
                path = [.thread(id)]
                app.route = nil
            }
        }
    }

    private var sorted: [JSON] { all.sorted { ($0["last"].double ?? 0) > ($1["last"].double ?? 0) } }
    private var live: [JSON] { sorted.filter { ["working", "starting", "waiting"].contains($0["status"].string ?? "") } }
    private var rest: [JSON] { sorted.filter { !["working", "starting", "waiting"].contains($0["status"].string ?? "") } }

    private func section(_ title: String, _ rows: [JSON], empty: String) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionHead(title: title, note: "\(rows.count)").padding(.bottom, Space.s)
            Hairline()
            if rows.isEmpty {
                LoadState(loading: loading && all.isEmpty, problem: all.isEmpty ? problem : nil, empty: empty)
            }
            ForEach(rows, id: \.self) { t in
                let waiting = t["status"].string == "waiting"
                NavigationLink(value: Dest.thread(t["id"].text)) {
                    ListRow(title: threadLabel(t),
                            detail: [t["agent"].string, t["project"].string, waiting ? "waiting on you" : nil].compactMap { $0 }.joined(separator: " · "),
                            note: waiting ? nil : [t["status"].string, age(t["last"].double)].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "),
                            dot: statusDot(t["status"].string, asks: t["asks"].int ?? 0))
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func load() async {
        defer { loading = false }
        do {
            all = try await app.call("threads.list", ["all": true]).list
            problem = nil
        } catch {
            all = app.needs.threads
            problem = describe(error)
        }
        if projects.isEmpty, let p = try? await app.call("projects.list") { projects = p["projects"].list }
        else if projects.isEmpty, let c = app.cache.get("projects.list") { projects = c["projects"].list }
    }
}

/// A session's name as people say it.
func threadLabel(_ t: JSON) -> String {
    if let n = t["name"].string, !n.isEmpty { return n }
    return String(t["id"].text.prefix(8))
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
