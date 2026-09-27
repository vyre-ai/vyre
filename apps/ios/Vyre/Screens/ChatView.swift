import SwiftUI

/// Chats (a page; phone.md section 6): project filter chips (All, then each project; this replaces
/// the old Projects tab), then one card of sessions, newest first. A running session shows a dot
/// before its agent; one with an open ask shows the Beacon dot and its count. Each opens the
/// session, mirrored with streaming, sending and the keyboard lease.
struct ChatHome: View {
    @Environment(AppModel.self) private var app
    @State private var all: [JSON] = []
    @State private var loading = true
    @State private var problem: String?
    @State private var projects: [JSON] = []
    @State private var project: String?
    @State private var token: UUID?

    var body: some View {
        PullScroll {
            VStack(alignment: .leading, spacing: Space.m) {
                chips
                if shown.isEmpty {
                    LoadState(loading: loading && all.isEmpty, problem: all.isEmpty ? problem : nil,
                              empty: project == nil ? "No sessions yet. Ask from the Capsule to start one." : "No sessions in this project in the last day.")
                } else {
                    Card {
                        ForEach(Array(shown.enumerated()), id: \.element) { i, t in
                            if i > 0 { Hairline() }
                            NavigationLink(value: Dest.thread(t["id"].text)) { SessionRow(t: t) }
                                .buttonStyle(.plain)
                        }
                    }
                }
            }
            .padding(.horizontal, Space.gutter)
            .padding(.top, Space.s)
            .padding(.bottom, Space.l)
        }
        .vyreGround()
        .task { await load() }
        .onAppear {
            guard token == nil else { return }
            let watched: Set<String> = ["thread.started", "thread.finished", "thread.stopped", "ask.raised", "ask.answered"]
            token = app.hub.on { e in if watched.contains(e.type) { Task { await load() } } }
        }
    }

    private var shown: [JSON] {
        all.filter { project == nil || $0["project"].string == project }
            .sorted { ($0["last"].double ?? 0) > ($1["last"].double ?? 0) }
    }

    private var chips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Space.s) {
                FilterChip(label: "All", on: project == nil) { project = nil }
                ForEach(projects, id: \.self) { p in
                    let slug = p["slug"].text
                    FilterChip(label: p["name"].string ?? slug, on: project == slug) { project = slug }
                }
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
        if let p = try? await app.call("projects.list") {
            app.cache.put("projects.list", p)
            projects = p["projects"].list
        } else if projects.isEmpty, let c = app.cache.get("projects.list") { projects = c["projects"].list }
    }
}

/// A row in Chats: tile, name, time or the open-ask count, the status line, agent and project.
struct SessionRow: View {
    let t: JSON

    var body: some View {
        let asks = t["asks"].int ?? 0
        let running = ["working", "starting"].contains(t["status"].string ?? "")
        HStack(alignment: .top, spacing: Space.m) {
            Tile(name: t["agent"].string ?? threadLabel(t))
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline) {
                    Text(threadLabel(t)).vyre(.rowTitle).foregroundStyle(Color.text).lineLimit(1)
                    Spacer(minLength: Space.s)
                    if asks > 0 {
                        HStack(spacing: 4) { Dot(color: .beaconDot, size: 7); Text("\(asks)").vyre(.small).foregroundStyle(Color.beaconInk) }
                    } else {
                        Text(age(t["last"].double)).vyre(.small).foregroundStyle(Color.label)
                    }
                }
                Text(statusLine).vyre(.secondary).foregroundStyle(Color.text2).lineLimit(1)
                HStack(spacing: 6) {
                    if running { Dot(color: .text, size: 7) }
                    Text([t["agent"].string, t["project"].string].compactMap { $0 }.joined(separator: " · "))
                        .vyre(.small).foregroundStyle(Color.label).lineLimit(1)
                }
            }
        }
        .padding(.vertical, 12)
        .padding(.horizontal, 14)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private var statusLine: String {
        switch t["status"].string {
        case "waiting": "Waiting on you"
        case "working": "Working"
        case "starting": "Starting"
        case "stopped": t["stopped_reason"].string.map { "Stopped: \($0)" } ?? "Stopped"
        default: "Idle"
        }
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
    /// Open session's target, flashing `--match` for 1.2 s.
    @State private var flash: Transcript.Target?
    @State private var flashOn = false
    /// New items scroll the view to the end, unless Open session put it somewhere else.
    @State private var following = true
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
                        ForEach(transcript.entries) { entry in
                            row(entry)
                                .background {
                                    if flash?.entry == entry.id {
                                        RoundedRectangle(cornerRadius: Radius.card).fill(Color.match).opacity(flashOn ? 1 : 0).padding(-Space.xs)
                                    }
                                }
                                .id(entry.id)
                        }
                        if transcript.working {
                            HStack(spacing: Space.s) { Dot(color: .focus); Engraved("Working", color: .focus) }
                        }
                        Color.clear.frame(height: 1).id("end")
                    }
                    .padding(.horizontal, Space.gutter)
                    .padding(.bottom, Space.m)
                }
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: transcript) { _, _ in
                    guard following else { return }
                    withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo("end", anchor: .bottom) }
                }
                .onChange(of: loaded) { _, _ in
                    if !land(proxy) { proxy.scrollTo("end", anchor: .bottom) }
                }
                .onChange(of: app.anchor) { _, a in if loaded, a?.thread == id { _ = land(proxy) } }
            }
            composer
        }
        .vyreGround()
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 0) {
                    Text(title).vyre(.title).foregroundStyle(Color.text).lineLimit(1)
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

    /// Open session (phone.md section 5): centre the anchored item and flash it once. False when
    /// there is no anchor for this thread, or the loaded transcript lacks it (the end is shown).
    private func land(_ proxy: ScrollViewProxy) -> Bool {
        guard let a = app.anchor, a.thread == id else { return false }
        app.anchor = nil
        guard let target = transcript.resolve(a) else { return false }
        following = false
        proxy.scrollTo(target.entry, anchor: .center)
        flash = target
        flashOn = true
        withAnimation(.easeOut(duration: 1.2)) { flashOn = false }
        Task {
            try? await Task.sleep(for: .seconds(1.3))
            flash = nil
        }
        return true
    }

    private var head: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            let bits = [record["agent"].string, record["project"].string, modelLabel(record["model"].string)].compactMap { $0 }
            if !bits.isEmpty { Text(bits.joined(separator: " · ")).vyre(.codeSmall).foregroundStyle(Color.label) }
            if offlineCopy { Engraved("Offline copy") }
            if recorded { Text("Recorded. Nothing is running it; a message resumes it if the box can.").vyre(.small).foregroundStyle(Color.text2) }
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
                Text(t).vyre(.body).foregroundStyle(Color.text).textSelection(.enabled)
            }
            .padding(Space.m)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.panel, in: RoundedRectangle(cornerRadius: Radius.panel))
        case .reply(_, let t, let done):
            VStack(alignment: .leading, spacing: Space.xs) {
                Engraved(replier)
                Text(markdown(t) + (done ? "" : " ")).vyre(.body).foregroundStyle(Color.text)
                    .textSelection(.enabled)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        case .notice(_, let t):
            HStack(alignment: .firstTextBaseline, spacing: Space.s) { Engraved("vyre"); Text(t).vyre(.small).foregroundStyle(Color.text2) }
        case .tools(_, let lines):
            VStack(alignment: .leading, spacing: Space.xs) {
                ForEach(lines.suffix(8)) { l in
                    HStack(alignment: .firstTextBaseline, spacing: Space.s) {
                        Dot(color: l.phase == "started" ? .focus : .label)
                        Text(l.error ? "failed" : l.phase == "started" ? "running" : "done").vyre(.label).foregroundStyle(Color.label).frame(width: 60, alignment: .leading)
                        Text(l.summary.isEmpty ? l.tool : l.summary).vyre(.codeSmall).foregroundStyle(Color.text2).lineLimit(2)
                    }
                }
                if lines.count > 8 { Engraved("and \(lines.count - 8) more") }
            }
            .padding(Space.m)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.codeBg, in: RoundedRectangle(cornerRadius: Radius.button))
        case .finished(_, let t):
            HStack(spacing: Space.s) { Hairline(); Engraved(t.isEmpty ? "turn done" : "turn done · \(t)").fixedSize(); Hairline() }
        case .stopped(_, let r):
            HStack(spacing: Space.s) { Hairline(); Engraved("stopped · \(r)").fixedSize(); Hairline() }
        case .gate(let gid):
            if let d = app.needs.held.first(where: { $0.id == gid }) {
                VStack(alignment: .leading, spacing: Space.s) {
                    HStack(spacing: Space.s) { Dot(color: .beaconInk); Engraved("Held before it went out", color: .beaconInk) }
                    Text(d.title).vyre(.title).foregroundStyle(Color.text)
                    HeldBody(draft: d, compact: true)
                }
                .padding(Space.gutter)
                .background(Color.panel, in: RoundedRectangle(cornerRadius: 12))
                .overlay { RoundedRectangle(cornerRadius: 12).strokeBorder(Color.ruleStrong, lineWidth: 1) }
                .id("held-\(d.id)-\(d.error ?? "")")
            } else {
                Engraved("A draft was held here. It is no longer waiting.")
            }
        case .ask(let aid):
            if let a = app.needs.asks.first(where: { $0.id == aid }) { AskCard(ask: a) }
            else { Engraved("A permission was asked here. It was answered.") }
        }
    }

    /// Who typed a turn: "you" for any person's surface, an agent by its name, and the assistant
    /// for a module's prompt. The model is never named (a user rule).
    private func who(_ surface: String?) -> String {
        guard let s = surface else { return app.assistantLabel }
        if s.hasPrefix("agent:") { return String(s.dropFirst(6)) }
        return "you"
    }

    /// Who answers: the thread's agent, else the assistant ("Vyre" when the box names none).
    private var replier: String {
        if let a = record["agent"].string, !a.isEmpty { return a }
        return app.assistantLabel
    }

    private func markdown(_ t: String) -> AttributedString {
        (try? AttributedString(markdown: t, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(t)
    }

    // MARK: composer

    private var composer: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            if let h = holder, h != ThreadView.surface, !focused {
                Text("\(holderName(h)) has the keyboard. Typing here takes it.").vyre(.small).foregroundStyle(Color.text2)
            }
            if let note {
                HStack(alignment: .firstTextBaseline) {
                    Text(note).vyre(.small).foregroundStyle(Color.text2)
                    Spacer()
                    if retryText != nil { Button("Take it and send") { Task { await takeAndSend() } }.buttonStyle(.quiet) }
                }
            }
            HStack(alignment: .bottom, spacing: Space.s) {
                TextField("", text: $text, prompt: Text(recorded ? "Resume with a message" : "Message").foregroundStyle(Color.label), axis: .vertical)
                    .vyre(.body)
                    .foregroundStyle(Color.text)
                    .lineLimit(1...6)
                    .focused($focused)
                    .padding(.horizontal, Space.m)
                    .padding(.vertical, 10)
                    .background(Color.bg, in: RoundedRectangle(cornerRadius: Radius.button))
                    .overlay {
                        RoundedRectangle(cornerRadius: Radius.button).strokeBorder(focused ? Color.focus : Color.ruleStrong, lineWidth: focused ? 2 : 1)
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
        following = true
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
