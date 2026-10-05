import SwiftUI

/// Chats (a page; phone.md section 6): project filter chips (All, then each project; this replaces
/// the old Projects tab), then one card of sessions, newest first. A running session shows a dot
/// before its agent; one with an open ask shows the attention dot and its count instead of the
/// time. A tap opens the session; swiping left archives it on this phone (the box has no archive
/// yet).
struct ChatHome: View {
    @Environment(AppModel.self) private var app
    @State private var all: [JSON] = []
    @State private var loading = true
    @State private var problem: String?
    @State private var projects: [JSON] = []
    @State private var project: String?
    @State private var token: UUID?
    @State private var showArchived = false
    @AppStorage("chats.archived") private var archivedRaw = ""

    var body: some View {
        let rows = shown
        List {
            Section {
                chips
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }
            Section {
                if rows.isEmpty {
                    LoadState(loading: loading && all.isEmpty, problem: all.isEmpty ? problem : nil,
                              empty: project == nil ? "No sessions yet. Ask from Lumen to start one." : "No sessions in this project in the last day.")
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets())
                }
                ForEach(rows, id: \.self) { t in
                    let tid = t["id"].text
                    Button { app.path.append(.thread(tid)) } label: { SessionRow(t: t) }
                        .buttonStyle(.plain)
                        .listRowBackground(Color.panel)
                        .listRowInsets(EdgeInsets())
                        .listRowSeparatorTint(Color.rule)
                        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                            Button { archive(tid, !archived.contains(tid)) } label: {
                                Label(archived.contains(tid) ? "Unarchive" : "Archive", systemImage: "archivebox")
                            }
                            .tint(Color.hover)
                        }
                        .accessibilityAction(named: archived.contains(tid) ? "Unarchive" : "Archive") { archive(tid, !archived.contains(tid)) }
                }
            } footer: {
                let hidden = all.filter { archived.contains($0["id"].text) && (project == nil || $0["project"].string == project) }.count
                if hidden > 0 {
                    Button { showArchived.toggle() } label: {
                        Text(showArchived ? "Hide the \(hidden) archived" : "\(hidden) archived on this phone. Show them")
                            .vyre(.small).foregroundStyle(Color.text)
                            .frame(minHeight: Space.target)
                    }
                    .buttonStyle(.plain)
                    .listRowInsets(EdgeInsets())
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .environment(\.defaultMinListRowHeight, 1)
        .listSectionSpacing(Space.s)
        .contentMargins(.horizontal, Space.gutter, for: .scrollContent)
        .background(Color.bg)
        .task { await load() }
        .onAppear {
            guard token == nil else { return }
            let watched: Set<String> = ["thread.started", "thread.finished", "thread.stopped", "ask.raised", "ask.answered"]
            token = app.hub.on { e in if watched.contains(e.type) { Task { await load() } } }
        }
        // Light by default: events drive it; a 60 s fallback while this page is on screen.
        .task(id: app.inFront) {
            while app.inFront && !Task.isCancelled {
                try? await Task.sleep(for: .seconds(60))
                if Task.isCancelled || !app.inFront { break }
                await load()
            }
        }
    }

    private var archived: Set<String> { Set(archivedRaw.split(separator: "\n").map(String.init)) }

    private func archive(_ id: String, _ on: Bool) {
        var a = archived
        if on { a.insert(id) } else { a.remove(id) }
        archivedRaw = a.sorted().joined(separator: "\n")
        if on { Haptics.warning() }
    }

    private var shown: [JSON] {
        all.filter { project == nil || $0["project"].string == project }
            .filter { showArchived || !archived.contains($0["id"].text) }
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

/// A row in Chats: tile, name, time or the open-ask count, the last line, agent and project.
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
                            .accessibilityLabel("\(asks) waiting on you")
                    } else {
                        Text(age(t["last"].double)).vyre(.small).foregroundStyle(Color.label)
                    }
                }
                Text(lastLine).vyre(.secondary).foregroundStyle(Color.text2).lineLimit(1)
                HStack(spacing: 6) {
                    if running { Dot(color: .text, size: 7).accessibilityLabel("running") }
                    Text([t["agent"].string, t["project"].string, t["machine"].string].compactMap { $0 }.joined(separator: " · "))
                        .vyre(.small).foregroundStyle(Color.label).lineLimit(1)
                }
            }
        }
        .padding(.vertical, 12)
        .padding(.horizontal, 14)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    /// The session's last line when the box sends one, else what it is doing.
    private var lastLine: String {
        if let l = t["last_text"].string ?? t["preview"].string, !l.isEmpty { return l.replacingOccurrences(of: "\n", with: " ") }
        switch t["status"].string {
        case "waiting": return "Waiting on you"
        case "working": return "Working"
        case "starting": return "Starting"
        case "stopped": return t["stopped_reason"].string.map { "Stopped: \($0)" } ?? "Stopped"
        default: return "Idle"
        }
    }
}

/// A session's name as people say it.
func threadLabel(_ t: JSON) -> String {
    if let n = t["name"].string, !n.isEmpty { return n }
    return String(t["id"].text.prefix(8))
}

/// The centred time stamp at a gap of more than an hour: "Today 12:01", "Yesterday 18:40".
func stampText(_ ms: Double, now: Date = Date()) -> String {
    let d = Date(timeIntervalSince1970: ms / 1000)
    let cal = Calendar.current
    let time = d.formatted(date: .omitted, time: .shortened)
    if cal.isDate(d, inSameDayAs: now) { return "Today \(time)" }
    if let y = cal.date(byAdding: .day, value: -1, to: now), cal.isDate(d, inSameDayAs: y) { return "Yesterday \(time)" }
    return d.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated)) + " " + time
}

/// One session (phone.md section 6), pushed: the nav bar with the session and "<agent> ·
/// <project>", the transcript (you in bubbles, the agent's words plain, tool calls grouped in one
/// box, the approval and question cards, a caret while it streams), and the composer with send and
/// stop. It loads the last 50 events and pages back as you scroll up. Live while the app is in
/// front. Open session lands here centred on the anchored item, flashing it once.
struct ThreadView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
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
    /// How many events are loaded (the last N), and whether the box has older ones.
    @State private var limit = ThreadView.page
    @State private var more = false
    @State private var paging = false
    @State private var expanded: Set<String> = []
    /// Open session's target, flashing `--match` for 1.2 s.
    @State private var flash: Transcript.Target?
    @State private var flashOn = false
    /// New items scroll the view to the end, unless Open session put it somewhere else.
    @State private var following = true
    @AppStorage("chats.archived") private var archivedRaw = ""
    @FocusState private var focused: Bool

    static let surface = "ios"
    static let page = 50

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        if more {
                            HStack { Spacer(); if paging { ProgressView().tint(Color.label) } else { Engraved("Earlier") }; Spacer() }
                                .frame(minHeight: Space.target)
                                .onAppear { Task { await pageBack(proxy) } }
                        }
                        notes
                        if !loaded && problem == nil { LoadState(loading: true, problem: nil, empty: nil) }
                        if let problem { FailedLine(text: problem) }
                        if loaded && transcript.entries.isEmpty { EmptyLine(text: recorded ? "This session has no turns to show." : "Nothing said yet.") }
                        let stamps = transcript.stamped()
                        ForEach(transcript.entries) { entry in
                            VStack(alignment: .leading, spacing: 14) {
                                if stamps.contains(entry.id), let t = transcript.times[entry.id] {
                                    Text(stampText(t)).vyre(.small).foregroundStyle(Color.label).frame(maxWidth: .infinity)
                                }
                                row(entry)
                                    .background {
                                        if flash?.entry == entry.id && flash?.line == nil {
                                            RoundedRectangle(cornerRadius: Radius.card).fill(Color.match).opacity(flashOn ? 1 : 0).padding(-Space.xs)
                                        }
                                    }
                            }
                            .id(entry.id)
                        }
                        Color.clear.frame(height: 1).id("end")
                    }
                    .padding(.horizontal, Space.gutter)
                    .padding(.vertical, Space.m)
                }
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: transcript) { _, _ in
                    guard following, !paging else { return }
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
                    if !subtitle.isEmpty { Text(subtitle).vyre(.micro).foregroundStyle(Color.label).lineLimit(1) }
                }
                .accessibilityElement(children: .combine)
            }
            ToolbarItem(placement: .topBarTrailing) { menu }
        }
        .vyreNavBar()
        .task { await load() }
        .onAppear { listen() }
        .onDisappear {
            app.hub.off(token)
            token = nil
            if holder == ThreadView.surface { Task { await release() } }
        }
        // The lease lives 90 s: renew it every 60 s while this phone holds it and types here.
        .task(id: focused && app.inFront && holder == ThreadView.surface) {
            guard focused && app.inFront && holder == ThreadView.surface else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(60))
                if Task.isCancelled || !focused { break }
                await lease()
            }
        }
    }

    private var title: String { record["name"].string ?? (recorded ? "Recorded session" : "Session") }

    /// "<agent> · <project>", and the Mac when the session runs on one.
    private var subtitle: String {
        var bits = [record["agent"].string ?? (recorded ? nil : app.assistantLabel), record["project"].string].compactMap { $0 }
        if let m = record["machine"].string { bits.append(record["away"].bool == true ? "\(m) is away" : m) }
        return bits.joined(separator: " · ")
    }

    /// Who answers in this session: its agent, else the assistant ("Vyre" when none is known).
    private var author: String {
        if let a = record["agent"].string, !a.isEmpty { return a }
        return app.assistantLabel
    }

    @ViewBuilder
    private var notes: some View {
        if offlineCopy { Text("Offline copy. Showing what this phone kept.").vyre(.small).foregroundStyle(Color.text2) }
        if record["away"].bool == true { Text("The Mac is away. This is the transcript as it was; it cannot take a message now.").vyre(.small).foregroundStyle(Color.text2) }
        if recorded { Text("Recorded. Nothing is running it; a message resumes it if the box can.").vyre(.small).foregroundStyle(Color.text2) }
    }

    /// More: watch, stop, archive, reload. Rename needs a box tool that does not exist yet.
    private var menu: some View {
        Menu {
            Button { Task { await watch() } } label: { Label("Tell me when it finishes", systemImage: "bell") }
            if ["working", "starting", "waiting"].contains(record["status"].string ?? "") && !recorded {
                Button { Task { await stop() } } label: { Label("Stop", systemImage: "stop") }
            }
            Button {
                var a = Set(archivedRaw.split(separator: "\n").map(String.init))
                a.insert(id)
                archivedRaw = a.sorted().joined(separator: "\n")
                dismiss()
            } label: { Label("Archive on this phone", systemImage: "archivebox") }
            Button { Task { await load() } } label: { Label("Reload", systemImage: "arrow.clockwise") }
        } label: {
            Image(systemName: "ellipsis").font(.system(size: 17, weight: .regular)).foregroundStyle(Color.text)
                .frame(width: Space.target, height: Space.target)
                .contentShape(Rectangle())
        }
        .accessibilityLabel("More")
    }

    // MARK: rows

    @ViewBuilder
    private func row(_ entry: Transcript.Entry) -> some View {
        switch entry {
        case .said(_, let t, let surface):
            if let s = surface, !s.hasPrefix("agent:") {
                YouBubble(text: t)
            } else {
                AgentMessage(author: surface.map { String($0.dropFirst(6)) } ?? app.assistantLabel, text: t, streaming: false)
            }
        case .reply(_, let t, let done):
            AgentMessage(author: author, text: t, streaming: !done)
        case .notice(_, let t):
            Text(t).vyre(.small).foregroundStyle(Color.text2).frame(maxWidth: .infinity, alignment: .leading)
        case .tools(let key, let lines):
            ToolBox(lines: lines, running: transcript.working, expanded: $expanded,
                    flashLine: flash?.entry == key ? flash?.line : nil, flashOn: flashOn)
        case .finished(_, let t):
            if !t.isEmpty { Text(t).vyre(.small).foregroundStyle(Color.label).frame(maxWidth: .infinity) }
        case .stopped(_, let r):
            Text("Stopped · \(r)").vyre(.small).foregroundStyle(Color.label).frame(maxWidth: .infinity)
        case .gate(let gid):
            if let d = app.needs.held.first(where: { $0.id == gid }) { HeldCard(draft: d) }
            else { AnsweredLine(text: "A draft was held here. It is no longer waiting.") }
        case .ask(let aid):
            if let a = app.needs.asks.first(where: { $0.id == aid }) {
                if a.isQuestion { QuestionCard(ask: a) } else { ApprovalCard(ask: a) }
            } else if let ans = transcript.answers[aid] {
                AnsweredLine(text: ans.line(project: record["project"].string, question: transcript.questions.contains(aid),
                                            time: ans.at > 0 ? Date(timeIntervalSince1970: ans.at / 1000).formatted(date: .omitted, time: .shortened) : ""))
            } else {
                AnsweredLine(text: "Answered.")
            }
        }
    }

    // MARK: composer

    private var streaming: Bool { transcript.working && !recorded }
    private var hasText: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    /// The composer (phone.md section 6): attach, the input, and send (once there is text) or stop
    /// (while a reply streams). Sending moves the keyboard to this phone; when another surface
    /// holds it, one line above says who.
    private var composer: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let h = holder, h != ThreadView.surface {
                Text("\(holderName(h)) has the keyboard. Sending takes it.").vyre(.small).foregroundStyle(Color.text2)
            }
            if let note { Text(note).vyre(.small).foregroundStyle(Color.text2).fixedSize(horizontal: false, vertical: true) }
            HStack(alignment: .bottom, spacing: Space.s) {
                Button { note = "Attaching a file from the phone needs the box to take files. It does not yet." } label: {
                    Image(systemName: "plus").font(.system(size: 17, weight: .regular)).foregroundStyle(Color.text)
                        .frame(width: 36, height: 36)
                        .background(Color.hover, in: Circle())
                        .frame(width: Space.target, height: Space.target)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Attach")
                TextField("", text: $text, prompt: Text(recorded ? "Resume with a message" : "Message \(author)").foregroundStyle(Color.label), axis: .vertical)
                    .vyre(.input)
                    .foregroundStyle(Color.text)
                    .lineLimit(1...6)
                    .focused($focused)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .frame(minHeight: 38)
                    .overlay {
                        RoundedRectangle(cornerRadius: 19).strokeBorder(focused ? Color.focus : Color.ruleStrong, lineWidth: focused ? 2 : 1)
                    }
                    .padding(.vertical, 3)
                if streaming && !hasText {
                    Button { Task { await stop() } } label: {
                        RoundedRectangle(cornerRadius: 2).fill(Color.bg).frame(width: 11, height: 11)
                            .frame(width: 36, height: 36)
                            .background(Color.text, in: Circle())
                            .frame(width: Space.target, height: Space.target)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Stop")
                } else {
                    Button { Task { await send() } } label: {
                        Image(systemName: "arrow.up").font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(hasText ? Color.primaryInk : Color.label)
                            .frame(width: 36, height: 36)
                            .background(hasText ? Color.primaryBg : Color.hover, in: Circle())
                            .frame(width: Space.target, height: Space.target)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(sending || !hasText)
                    .accessibilityLabel("Send")
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, Space.s)
        .background(Color.bg)
        .overlay(alignment: .top) { Hairline() }
    }

    private func holderName(_ h: String) -> String {
        switch h {
        case "deck": "The Deck"
        case "capsule": "Lumen"
        case "android": "Your Android phone"
        default: h.hasPrefix("tailnet:") ? "Another device" : h.hasPrefix("agent:") ? String(h.dropFirst(6)) : h
        }
    }

    // MARK: landing

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

    // MARK: loading

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
        case "thread.started", "thread.sent": record = record.with("status", "working")
        case "thread.finished": record = record.with("status", "idle")
        case "thread.stopped": record = record.with("status", "stopped")
        case "ask.raised": record = record.with("status", "waiting")
        default: break
        }
    }

    /// The last `limit` events. When Open session's anchor is older than that, read further back
    /// (up to 1000) until it is in.
    private func load() async {
        problem = nil
        while true {
            do {
                let out = try await app.call("threads.get", ["thread": .string(id), "limit": .number(Double(limit))])
                app.cache.putThread(id, out)
                show(out, offline: false)
            } catch {
                if let c = app.cache.thread(id) { show(c, offline: true) }
                else { await loadRecorded() }
                break
            }
            if let a = app.anchor, a.thread == id, transcript.resolve(a) == nil, more, limit < 1000 {
                limit = min(1000, limit * 2)
                continue
            }
            break
        }
        loaded = true
    }

    /// No live thread: a recorded session, read from recall.
    private func loadRecorded() async {
        do {
            let out = try await app.call("recall.thread", ["session": .string(id), "limit": 400])
            var t = Transcript()
            t.load(turns: out["turns"].list)
            transcript = t
            let s = out["session"]
            record = ["name": JSON(s["title"].string ?? s["name"].string)]
            recorded = true
        } catch {
            problem = describe(error)
        }
    }

    /// Scrolled to the top: read the next 50 back and keep the first item where it was.
    private func pageBack(_ proxy: ScrollViewProxy) async {
        guard more, !paging, loaded else { return }
        paging = true
        defer { paging = false }
        let first = transcript.entries.first?.id
        limit += ThreadView.page
        if let out = try? await app.call("threads.get", ["thread": .string(id), "limit": .number(Double(limit))]) {
            show(out, offline: false)
            if let first { proxy.scrollTo(first, anchor: .top) }
        }
    }

    private func show(_ out: JSON, offline: Bool) {
        var t = Transcript()
        let events = out["events"].list
        for j in events { if let e = VyreEvent(j) { t.apply(e) } }
        for a in out["asks"].list where (a["state"].string ?? "open") == "open" {
            t.apply(VyreEvent(id: 0, at: 0, type: "ask.raised", payload: ["ask": a["id"], "kind": a["kind"]]))
        }
        let rec = out["thread"]
        t.working = ["working", "starting"].contains(rec["status"].string ?? "")
        more = events.count >= limit
        transcript = t
        record = rec
        holder = rec["holder"].string
        offlineCopy = offline
        recorded = false
        for e in buffer { take(e) }
        buffer = []
    }

    // MARK: actions

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

    /// Send: the keyboard moves to this phone first when another surface holds it.
    private func send() async {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        sending = true
        defer { sending = false }
        note = nil
        following = true
        if let h = holder, h != ThreadView.surface { await lease() }
        do {
            var out = try await app.call("threads.send", ["thread": .string(id), "text": .string(t), "surface": .string(ThreadView.surface)])
            if out["sent"].bool != true, out["open_elsewhere"].bool != true, out["holder"].string != nil {
                // Someone took it between the lease and the send: take it back once.
                await lease()
                out = try await app.call("threads.send", ["thread": .string(id), "text": .string(t), "surface": .string(ThreadView.surface)])
            }
            if out["sent"].bool == true {
                text = ""
                transcript.echo(t)
                holder = ThreadView.surface
            } else if out["open_elsewhere"].bool == true {
                note = out["note"].string ?? "This session is open in a terminal. Type there, or close it first."
            } else {
                note = out["note"].string ?? "\(holderName(out["holder"].text)) has the keyboard."
            }
        } catch { note = describe(error) }
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

/// You: a bubble on the right, max 290 wide, `--hover`, `--rule` border, radius 18 18 6 18.
struct YouBubble: View {
    let text: String
    var body: some View {
        let shape = UnevenRoundedRectangle(topLeadingRadius: 18, bottomLeadingRadius: 18, bottomTrailingRadius: 6, topTrailingRadius: 18)
        HStack {
            Spacer(minLength: 48)
            Text(text).vyre(.input).foregroundStyle(Color.text)
                .textSelection(.enabled)
                .padding(.vertical, 10)
                .padding(.horizontal, 14)
                .background(Color.hover, in: shape)
                .overlay { shape.strokeBorder(Color.rule, lineWidth: 1) }
                .frame(maxWidth: 290, alignment: .trailing)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("You: \(text)")
    }
}

/// The agent: no bubble. A 24 px tile and the author, then the words in Lead type, with a caret
/// (2 x 19, `--text`, blinking at 1 s) while they stream.
struct AgentMessage: View {
    let author: String
    let text: String
    let streaming: Bool
    @Environment(\.accessibilityReduceMotion) private var still

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: Space.s) {
                Tile(name: author, size: 24)
                Text(author).vyre(.small, weight: 600).foregroundStyle(Color.text2)
            }
            if streaming {
                TimelineView(.periodic(from: .now, by: 0.5)) { ctx in
                    let on = still || Int(ctx.date.timeIntervalSince1970 * 2) % 2 == 0
                    (Text(markdown(text)) + Text("\u{258F}").foregroundStyle(on ? Color.text : Color.clear))
                        .vyre(.lead).foregroundStyle(Color.text)
                }
            } else {
                Text(markdown(text)).vyre(.lead).foregroundStyle(Color.text).textSelection(.enabled)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    private func markdown(_ t: String) -> AttributedString {
        (try? AttributedString(markdown: t, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(t)
    }
}

/// Tool calls grouped in one box (`--rule` border, radius 10, hairlines between rows). Each row is
/// mono 13/18: a check (done), a spinner (running) or a crossed circle (failed), the action and
/// target, and the result. A tap expands it in place: the full command, the output (12 lines, then
/// Show all) when the box sends it.
struct ToolBox: View {
    let lines: [Transcript.ToolLine]
    let running: Bool
    @Binding var expanded: Set<String>
    let flashLine: String?
    let flashOn: Bool
    @State private var earlier = false

    static let cap = 30

    var body: some View {
        let shown = earlier ? lines : Array(lines.suffix(ToolBox.cap))
        VStack(alignment: .leading, spacing: 0) {
            if lines.count > shown.count {
                Button { earlier = true } label: {
                    Text("Show \(lines.count - shown.count) earlier").vyre(.small, weight: 600).foregroundStyle(Color.text)
                        .padding(.horizontal, 12).frame(minHeight: Space.target)
                }
                .buttonStyle(.plain)
                Hairline()
            }
            ForEach(Array(shown.enumerated()), id: \.element.id) { i, l in
                if i > 0 { Hairline() }
                ToolRow(line: l, running: running, open: Binding(get: { expanded.contains(l.id) },
                                                               set: { on in if on { expanded.insert(l.id) } else { expanded.remove(l.id) } }))
                    .background(flashLine == l.id ? Color.match.opacity(flashOn ? 1 : 0) : Color.clear)
            }
        }
        .background(Color.panel, in: RoundedRectangle(cornerRadius: Radius.card))
        .overlay { RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Color.rule, lineWidth: 1) }
        .clipShape(RoundedRectangle(cornerRadius: Radius.card))
    }
}

struct ToolRow: View {
    let line: Transcript.ToolLine
    let running: Bool
    @Binding var open: Bool
    @State private var all = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button { withAnimation(.easeOut(duration: 0.18)) { open.toggle() } } label: {
                HStack(alignment: .center, spacing: Space.s) {
                    Group {
                        if line.error { Image(systemName: "xmark.circle") }
                        else if line.phase == "started" && running { ProgressView().controlSize(.mini).tint(Color.label) }
                        else { Image(systemName: "checkmark") }
                    }
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Color.label)
                    .frame(width: 16, height: 16)
                    Text(line.action).vyre(.commandRow).foregroundStyle(Color.text).lineLimit(1).truncationMode(.middle)
                    Spacer(minLength: Space.s)
                    if line.error { Text("failed").vyre(.commandRow).foregroundStyle(Color.label) }
                }
                .padding(.vertical, 9)
                .padding(.horizontal, 12)
                .frame(minHeight: Space.target)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(line.action)\(line.error ? ", failed" : "")")
            .accessibilityHint(open ? "Collapse" : "Expand")
            if open {
                VStack(alignment: .leading, spacing: Space.s) {
                    Text(line.summary.isEmpty ? line.tool : line.summary).vyre(.codeSmall).foregroundStyle(Color.text2)
                        .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    if let o = line.output, !o.isEmpty {
                        let rows = o.split(separator: "\n", omittingEmptySubsequences: false)
                        Text((all ? rows : Array(rows.prefix(12))).joined(separator: "\n")).vyre(.codeSmall).foregroundStyle(Color.text2)
                            .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                        if rows.count > 12 && !all {
                            Button("Show all") { all = true }.buttonStyle(.quiet)
                        }
                    }
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}
