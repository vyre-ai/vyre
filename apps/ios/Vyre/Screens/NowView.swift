import SwiftUI

/// Now (phone.md section 4): the one-row setup reminder, "Needs you" as one card of rows (held
/// drafts, permission asks and questions), "Working", and "From memory". A tap on a row opens the
/// detail sheet. Swiping right approves an ask at once; a draft first opens the sheet with its
/// final words, and a question opens its sheet. Swiping left denies, discards or puts off, with
/// Undo. Needs, Working and memory come from events; nothing polls.
struct NowView: View {
    @Environment(AppModel.self) private var app
    @State private var steps: [String: Step] = [:]
    @State private var facts: [JSON] = []
    @State private var busy: Set<String> = []
    @State private var token: UUID?
    @State private var tick = Date()
    @AppStorage("now.swiped") private var swiped = false

    struct Step: Equatable { var latest: String; var count: Int }

    var body: some View {
        List {
            if let setup = setupLine {
                Section {
                    Button { app.sheet = .settings } label: {
                        HStack {
                            Text(setup).vyre(.secondary).foregroundStyle(Color.text)
                            Spacer()
                            Image(systemName: "chevron.right").font(.system(size: 14, weight: .semibold)).foregroundStyle(Color.label)
                        }
                        .frame(minHeight: Space.target)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(Color.panel)
                }
            }
            if let gone = app.gone {
                Section { FailedLine(text: gone).listRowBackground(Color.clear) }
            }
            needsSection
            workingSection
            memorySection
            Color.clear.frame(height: 1).listRowBackground(Color.clear).listRowSeparator(.hidden)
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .environment(\.defaultMinListRowHeight, 1)
        .listSectionSpacing(0)
        .contentMargins(.horizontal, Space.gutter, for: .scrollContent)
        .background(Color.bg)
        .overlay(alignment: .bottom) { toastView }
        .animation(.easeOut(duration: 0.18), value: items.map(\.id))
        .task { await loadFacts() }
        .task(id: "tick") {
            // The elapsed times on Working move once a minute, and only while Now is on screen.
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(60))
                tick = Date()
            }
        }
        .onAppear { listen() }
        .onChange(of: app.needs.count) { old, new in
            if new > old && app.page == .now && app.inFront && app.path.isEmpty && app.sheet == nil && app.detail == nil { Haptics.warning() }
        }
    }

    // MARK: setup

    /// Anything missing on this phone, as one row (phone.md section 4, Setup and pairing).
    private var setupLine: String? {
        if !app.push.enabled { return "Turn on notifications for this phone" }
        return nil
    }

    // MARK: needs you

    private var items: [NeedItem] {
        let held = app.needs.held.map(NeedItem.held)
        let asks = app.needs.asks.map(NeedItem.of)
        return (held + asks).filter { !app.needs.hidden.contains($0.id) }.sorted { $0.at < $1.at }
    }

    @ViewBuilder
    private var needsSection: some View {
        let rows = items
        Section {
            if rows.isEmpty {
                Text(app.needs.loaded || !app.online ? "Nothing needs you." : "Looking.")
                    .vyre(.secondary).foregroundStyle(Color.label)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
            }
            ForEach(rows) { item in
                NeedRow(item: item, failure: app.needs.failed[item.id], busy: busy.contains(item.id)) { open(item) }
                    .listRowBackground(Color.panel)
                    .listRowInsets(EdgeInsets())
                    .listRowSeparatorTint(Color.rule)
                    .swipeActions(edge: .leading, allowsFullSwipe: true) {
                        Button { swipeRight(item) } label: {
                            Label(item.approveVerb, systemImage: item.faceID ? Biometry.glyph : item.isDraft ? "arrow.up" : item.isQuestion ? "text.bubble" : "checkmark")
                        }
                        .tint(Color.primaryBg)
                    }
                    .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                        Button { swipeLeft(item) } label: { Label(item.denyVerb, systemImage: item.isQuestion ? "clock" : "xmark") }
                            .tint(Color.hover)
                    }
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(item.spoken())
                    .accessibilityAddTraits(.isButton)
                    .accessibilityAction { open(item) }
                    .accessibilityAction(named: item.approveVerb) { swipeRight(item) }
                    .accessibilityAction(named: item.denyVerb) { swipeLeft(item) }
                    .accessibilityAction(named: "Open") { open(item) }
            }
        } header: {
            SectionHeader(title: "Needs you", count: rows.isEmpty ? nil : rows.count, dot: rows.isEmpty ? nil : .beaconDot)
                .textCase(nil)
                .listRowInsets(EdgeInsets())
        } footer: {
            if !rows.isEmpty && !swiped {
                Text(rows.contains(where: \.faceID) ? "Swipe right to approve with \(Biometry.name), left to deny." : "Swipe right to approve, left to deny.")
                    .vyre(.small).foregroundStyle(Color.label)
                    .listRowInsets(EdgeInsets(top: Space.s, leading: 0, bottom: 0, trailing: 0))
            }
        }
    }

    private func open(_ item: NeedItem) {
        app.detail = DetailRef(id: item.id)
    }

    /// Swipe right. An ask is approved at once (Face ID only if the box needs it and no session
    /// covers it). A draft that goes out first shows its final words: the sheet opens on it, and
    /// Send is there. A question has no one-swipe answer: its sheet opens.
    private func swipeRight(_ item: NeedItem) {
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        swiped = true
        guard case .ask(let a) = item else { open(item); return }
        guard !busy.contains(item.id) else { return }
        busy.insert(item.id)
        app.needs.failed[item.id] = nil
        Task {
            defer { busy.remove(item.id) }
            do {
                try await app.needs.answer(a, .allow)
            } catch where isCancel(error) {
            } catch {
                app.needs.failed[item.id] = describe(error)
                Haptics.warning()
            }
        }
    }

    /// Swipe left: Deny, Discard or Later, with 4 s of Undo (NeedsStore.dismiss).
    private func swipeLeft(_ item: NeedItem) {
        swiped = true
        app.needs.dismiss(item)
    }

    @ViewBuilder
    private var toastView: some View {
        if let t = app.needs.toast {
            HStack {
                Text(t.text).vyre(.secondary).foregroundStyle(Color.text)
                Spacer()
                Button("Undo") { app.needs.undo(t.id) }.buttonStyle(.quiet)
            }
            .padding(.leading, Space.gutter)
            .frame(minHeight: 48)
            .background(Color.panel, in: RoundedRectangle(cornerRadius: Radius.card))
            .overlay { RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Color.ruleStrong, lineWidth: 1) }
            .padding(.horizontal, Space.gutter)
            .padding(.bottom, Space.s)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }

    // MARK: working

    /// Running sessions, and ones that finished in the last hour ("Done"). When nothing ran,
    /// the two most recent sessions stand in.
    private var working: [JSON] {
        let now = tick.timeIntervalSince1970 * 1000
        let all = app.needs.threads.sorted { ($0["last"].double ?? 0) > ($1["last"].double ?? 0) }
        let live = all.filter { t in
            let s = t["status"].string ?? ""
            if ["working", "starting", "waiting"].contains(s) { return true }
            return now - (t["last"].double ?? 0) < 3_600_000 && steps[t["id"].text] != nil
        }
        return live.isEmpty ? Array(all.prefix(2)) : live
    }

    @ViewBuilder
    private var workingSection: some View {
        let rows = working
        if !rows.isEmpty {
            Section {
                ForEach(rows, id: \.self) { t in
                    Button { app.path.append(.thread(t["id"].text)) } label: { WorkingRow(t: t, step: steps[t["id"].text], now: tick) }
                        .buttonStyle(.plain)
                        .listRowBackground(Color.panel)
                        .listRowInsets(EdgeInsets())
                        .listRowSeparatorTint(Color.rule)
                }
            } header: {
                SectionHeader(title: "Working", count: rows.filter { ["working", "starting", "waiting"].contains($0["status"].string ?? "") }.count)
                    .textCase(nil)
                    .listRowInsets(EdgeInsets())
            }
        }
    }

    // MARK: from memory

    /// What memory learned today (`memory.facts`, seen since midnight).
    @ViewBuilder
    private var memorySection: some View {
        let start = Calendar.current.startOfDay(for: Date()).timeIntervalSince1970 * 1000
        let today = facts.filter { ($0["seen"].double ?? $0["since"].double ?? 0) >= start }
        if let first = today.first {
            Section {
                Button {
                    app.findPath = [.fact(first["id"].text)]
                    app.sheet = .find
                } label: {
                    VStack(alignment: .leading, spacing: Space.s) {
                        HStack(spacing: 6) {
                            Image(systemName: "clock.arrow.circlepath").font(.system(size: 14))
                            Text("From memory").vyre(.small, weight: 600)
                        }
                        .foregroundStyle(Color.recall)
                        ForEach(today.prefix(2), id: \.self) { f in
                            Text(f["text"].text).font(VyreFonts.base(.secondary).asFont(size: 15)).lineSpacing(6)
                                .foregroundStyle(Color.text).frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    .padding(.vertical, 12)
                    .padding(.horizontal, 14)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .listRowBackground(Color.recallWash)
                .listRowInsets(EdgeInsets())
            } header: {
                Color.clear.frame(height: Space.l).listRowInsets(EdgeInsets())
            }
        }
    }

    // MARK: live

    private func listen() {
        guard token == nil else { return }
        token = app.hub.on { e in
            guard let t = e.thread else {
                if e.type == "memory.curated" { Task { await loadFacts() } }
                return
            }
            if e.type == "thread.tool", e["phase"].string == "started" {
                let summary = e["summary"].string ?? e["tool"].text
                steps[t] = Step(latest: summary, count: (steps[t]?.count ?? 0) + 1)
            } else if e.type == "thread.started" {
                steps[t] = Step(latest: "Starting", count: 0)
            }
        }
    }

    private func loadFacts() async {
        if let out = try? await app.call("memory.facts", ["limit": 200]) { facts = out["facts"].list }
    }
}

/// A Needs you row (phone.md section 4): tile, title and time, the command or subject, agent and
/// project, and the reason when an approval failed.
struct NeedRow: View {
    let item: NeedItem
    let failure: String?
    let busy: Bool
    let tap: () -> Void

    var body: some View {
        Button(action: tap) {
            HStack(alignment: .top, spacing: Space.m) {
                Tile(name: item.agent ?? item.title)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(item.title).vyre(.rowTitle).foregroundStyle(Color.text).lineLimit(1)
                        Spacer(minLength: Space.s)
                        if busy { ProgressView().controlSize(.small) }
                        else { Text(age(item.at)).vyre(.small).foregroundStyle(Color.label) }
                    }
                    Text(item.line2)
                        .vyre(item.line2IsCommand ? .commandRow : .secondary)
                        .foregroundStyle(Color.text2)
                        .lineLimit(1).truncationMode(.tail)
                    if !item.line3.isEmpty { Text(item.line3).vyre(.small).foregroundStyle(Color.label).lineLimit(1) }
                    if let failure { FailedLine(text: failure).padding(.top, 2) }
                }
                Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(Color.label)
                    .padding(.top, 3)
            }
            .padding(.vertical, 12)
            .padding(.horizontal, 14)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// A Working row: tile, session name with its step count, the latest step, and how long it has
/// run ("Done" once a finished turn is under an hour old).
struct WorkingRow: View {
    let t: JSON
    let step: NowView.Step?
    let now: Date

    var body: some View {
        let status = t["status"].string ?? ""
        let running = ["working", "starting", "waiting"].contains(status)
        HStack(alignment: .top, spacing: Space.m) {
            Tile(name: t["agent"].string ?? threadLabel(t))
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline) {
                    Text(threadLabel(t)).vyre(.rowTitle).foregroundStyle(Color.text).lineLimit(1)
                    Spacer(minLength: Space.s)
                    if running {
                        Text(elapsed).font(VyreFonts.base(.commandRow).asFont(size: 13)).foregroundStyle(Color.label)
                    } else {
                        Text(step == nil ? age(t["last"].double) : "Done").vyre(.small).foregroundStyle(Color.label)
                    }
                }
                Text(line).vyre(.secondary).foregroundStyle(status == "waiting" ? Color.beaconInk : Color.text2).lineLimit(1)
                if let n = step?.count, n > 0 {
                    Text(n == 1 ? "1 step" : "\(n) steps").vyre(.small).foregroundStyle(Color.label)
                }
            }
        }
        .padding(.vertical, 12)
        .padding(.horizontal, 14)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private var line: String {
        if t["status"].string == "waiting" { return "Waiting on you" }
        if let s = step?.latest, !s.isEmpty { return s }
        return [t["agent"].string, t["project"].string].compactMap { $0 }.joined(separator: " · ")
    }

    private var elapsed: String {
        guard let started = t["started"].double else { return age(t["last"].double) }
        let s = max(0, Int(now.timeIntervalSince1970 - started / 1000))
        return s >= 3600 ? String(format: "%d:%02d:%02d", s / 3600, s / 60 % 60, s % 60) : String(format: "%02d:%02d", s / 60, s % 60)
    }
}
