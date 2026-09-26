import SwiftUI

/// Now: what needs the person (held drafts edited in place, open asks), what is running, and what
/// happened lately. The Deck's views/now.js and the boards' PhoneNow.
struct NowView: View {
    @Environment(AppModel.self) private var app
    @State private var path: [Dest] = []
    @State private var activity: [VyreEvent] = []
    @State private var activityProblem: String?
    @State private var highlight: String?
    @State private var gone: String?
    @State private var token: UUID?

    static let activityTypes: Set<String> = ["thread.started", "thread.finished", "thread.stopped", "gate.held", "gate.released",
                                             "gate.rejected", "gate.failed", "ask.raised", "ask.answered", "thread.watched", "memory.curated"]

    var body: some View {
        NavigationStack(path: $path) {
            ScrollViewReader { proxy in
                PullScroll {
                    VStack(alignment: .leading, spacing: Space.xl) {
                        header
                        if let gone { FailedLine(text: gone) }
                        needsSection
                        workingSection
                        activitySection
                    }
                    .padding(.horizontal, Space.gutter)
                    .padding(.bottom, Space.xxl)
                }
                .onChange(of: highlight) { _, id in
                    if let id { withAnimation { proxy.scrollTo("ask-\(id)", anchor: .top) } }
                }
            }
            .vyreGround()
            .vyreDestinations()
            .toolbar(.hidden, for: .navigationBar)
        }
        .task { await loadActivity() }
        .onAppear { listen() }
        .onChange(of: app.route, initial: true) { _, _ in follow() }
        .onChange(of: app.needs.loaded) { _, _ in follow() }
    }

    // MARK: head

    private var header: some View {
        VStack(alignment: .leading, spacing: 0) {
            BrandBar {
                Button { path.append(.settings) } label: { Avatar(host: app.address?.host ?? "v") }.buttonStyle(.plain)
            }
            PageHead(eyebrow: todayLabel(), title: title, sub: sub)
        }
    }

    private var running: [JSON] { app.needs.threads.filter { $0["status"].string != "stopped" } }

    private var title: String {
        let n = app.needs.count
        if !app.needs.loaded && app.online { return "Looking." }
        return n == 0 ? "Nothing needs you." : "\(plural(n, "thing")) need\(n == 1 ? "s" : "") you."
    }

    private var sub: String {
        if let p = app.needs.problem { return p }
        let r = running.count
        return r == 0 ? "Nothing is running." : "\(plural(r, "thread")) running on \(r == 1 ? "its" : "their") own."
    }

    // MARK: needs you

    @ViewBuilder
    private var needsSection: some View {
        let held = app.needs.held
        let asks = app.needs.asks
        if !held.isEmpty || !asks.isEmpty {
            VStack(alignment: .leading, spacing: Space.m) {
                HStack(spacing: Space.s) { Dot(color: .beacon); SectionHead(title: "Needs you", note: "\(held.count + asks.count)", color: .beacon) }
                ForEach(held) { d in
                    NavigationLink(value: Dest.held(d.id)) { HeldRow(draft: d) }.buttonStyle(.plain)
                }
                ForEach(asks) { a in
                    AskCard(ask: a)
                        .id("ask-\(a.id)")
                        .overlay {
                            if highlight == a.id { RoundedRectangle(cornerRadius: Radius.panel).strokeBorder(Color.beacon, lineWidth: 2) }
                        }
                }
            }
        }
    }

    // MARK: working

    private var workingSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionHead(title: "Working", note: running.isEmpty ? nil : "\(running.count) running")
                .padding(.bottom, Space.s)
            Hairline()
            if running.isEmpty {
                EmptyLine(text: app.needs.loaded ? "Nothing is running. Start a session from Chat or the Capsule." : "")
            } else {
                ForEach(running, id: \.self) { t in
                    Button { app.open(.thread(t["id"].text)) } label: {
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

    // MARK: activity

    private var activitySection: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionHead(title: "Lately").padding(.bottom, Space.s)
            Hairline()
            if let activityProblem, activity.isEmpty { FailedLine(text: activityProblem).padding(.vertical, Space.m) }
            else if activity.isEmpty { EmptyLine(text: "Nothing has happened since the box started.") }
            ForEach(activity) { e in
                Button { if let t = e.thread, e.type.hasPrefix("thread.") || e.type.hasPrefix("ask.") { app.open(.thread(t)) } } label: {
                    HStack(alignment: .firstTextBaseline, spacing: Space.m) {
                        Text(time(e.at)).vyre(.codeSmall).foregroundStyle(Color.ash).frame(width: 44, alignment: .leading)
                        Text(line(e)).vyre(.small).foregroundStyle(Color.bone).frame(maxWidth: .infinity, alignment: .leading).lineLimit(2)
                    }
                    .padding(.vertical, Space.s)
                    .frame(minHeight: Space.target)
                    .contentShape(Rectangle())
                    .overlay(alignment: .bottom) { Hairline() }
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func time(_ ms: Double) -> String {
        let d = Date(timeIntervalSince1970: ms / 1000)
        let f = DateFormatter()
        f.locale = Locale.current
        f.setLocalizedDateFormatFromTemplate(Calendar.current.isDateInToday(d) ? "HH:mm" : "d MMM")
        return f.string(from: d)
    }

    private func threadName(_ e: VyreEvent) -> String {
        if let n = e["name"].string, !n.isEmpty { return n }
        if let t = e.thread, let rec = app.needs.threads.first(where: { $0["id"].string == t }), let n = rec["name"].string { return n }
        return "a session"
    }

    /// One sentence per event, from the payload fields the contract lists.
    private func line(_ e: VyreEvent) -> String {
        switch e.type {
        case "thread.started": return "Started \(threadName(e))."
        case "thread.finished": return e["ok"].bool == false ? "\(threadName(e)) ended a turn with an error." : "\(threadName(e)) finished a turn."
        case "thread.stopped": return "\(threadName(e)) stopped" + (e["reason"].string.map { ": \($0)." } ?? ".")
        case "gate.held": return "Held for you: \(e["summary"].string ?? "a draft")."
        case "gate.released": return "Released" + (e["to"].strings.isEmpty ? "" : " to \(e["to"].strings.joined(separator: ", "))") + (e["edited"].bool == true ? ", edited." : ".")
        case "gate.rejected": return "Discarded a draft" + (e["via"].string.map { " for \($0)" } ?? "") + "."
        case "gate.failed": return "A send failed and came back: \(e["error"].string ?? "no reason given")."
        case "ask.raised": return "\(threadName(e)) asked: \(e["summary"].text)"
        case "ask.answered":
            let d = e["decision"].string ?? "answered"
            return "\(d.prefix(1).uppercased() + d.dropFirst()): \(e["summary"].text)"
        case "thread.watched": return "A watch fired on \(threadName(e))" + (e["reason"].string.map { ": \($0)." } ?? ".")
        case "memory.curated": return "Memory was tidied."
        default: return e.type
        }
    }

    private func listen() {
        guard token == nil else { return }
        token = app.hub.on { e in
            guard NowView.activityTypes.contains(e.type), !activity.contains(where: { $0.id == e.id }) else { return }
            activity.insert(e, at: 0)
            if activity.count > 20 { activity.removeLast(activity.count - 20) }
        }
    }

    /// The last events of interest, read once from `GET /v1/events` (the stream only brings new ones).
    private func loadActivity() async {
        guard let client = app.client else { return }
        do {
            let last = try await client.health()["last_event"].int ?? 0
            var c = URLComponents(url: client.url("/v1/events"), resolvingAgainstBaseURL: false)!
            c.queryItems = [URLQueryItem(name: "since", value: String(max(0, last - 400))), URLQueryItem(name: "limit", value: "400")]
            let out = try await client.send(URLRequest(url: c.url!))
            let found = out.list.compactMap(VyreEvent.init).filter { NowView.activityTypes.contains($0.type) }
            var merged = Array(found.suffix(20).reversed())
            for e in activity where !merged.contains(where: { $0.id == e.id }) { merged.append(e) }
            activity = Array(merged.sorted { $0.id > $1.id }.prefix(20))
            activityProblem = nil
        } catch {
            activityProblem = describe(error)
        }
    }

    /// A tap on a push, or `-VyreOpen /needs/<id>`: open the held item, or scroll to the ask.
    private func follow() {
        if app.route == .settings {
            path = [.settings]
            app.route = nil
            return
        }
        guard case .needs(let id) = app.route else { return }
        if app.needs.held.contains(where: { $0.id == id }) {
            path = [.held(id)]
            app.route = nil
        } else if app.needs.asks.contains(where: { $0.id == id }) {
            path = []
            highlight = id
            app.route = nil
        } else if app.needs.loaded {
            gone = "That item is no longer waiting. It was answered somewhere else."
            app.route = nil
        }
    }
}

/// A held draft in the Now list: kind, title, who and when, the first line of the body.
struct HeldRow: View {
    let draft: HeldDraft

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            HStack {
                Engraved(draft.kind == "send" ? "Held draft" : "Held \(draft.kind)", color: .beacon)
                Spacer()
                Text([draft.agent, age(draft.at)].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                    .vyre(.codeSmall).foregroundStyle(Color.stone)
            }
            Text(draft.title).vyre(.title).foregroundStyle(Color.bone).lineLimit(2)
            if let body = draft.fields.first(where: { $0.key == "body" })?.value, !body.isEmpty {
                Text(body).vyre(.small).foregroundStyle(Color.stone).lineLimit(2)
            }
            if let e = draft.error { Text("Held again: \(e)").vyre(.small).foregroundStyle(Color.beacon).lineLimit(2) }
            HStack(spacing: Space.xs) {
                Text(draft.hasChanges ? "Edited. Open to send" : "Open to read, edit and \(draft.primaryLabel.lowercased())")
                    .vyre(.small).foregroundStyle(Color.ash)
                Image(systemName: "chevron.right").font(.system(size: 11)).foregroundStyle(Color.ash)
            }
        }
        .padding(Space.gutter)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.beaconWash, in: RoundedRectangle(cornerRadius: Radius.panel))
        .contentShape(Rectangle())
    }
}

/// What a pushed screen shows when its item went away.
struct GoneView: View {
    let text: String
    var body: some View {
        VStack(alignment: .leading) { EmptyLine(text: text); Spacer() }
            .padding(.horizontal, Space.gutter)
            .vyreGround()
            .vyreNavBar()
    }
}
