import SwiftUI

/// Memory: the facts Vyre holds, for everything or one project, searched by what they are about
/// (`memory.facts`, `memory.stats`), and why each is known (`memory.why`). Corrections stay on the
/// Deck: the box refuses `memory.correct` from a phone (CONTRACT.md 0.2). Nothing is cached.
struct MemoryView: View {
    @Environment(AppModel.self) private var app
    @State private var facts: [JSON] = []
    @State private var about: JSON = .null
    @State private var stats: JSON = .null
    @State private var projects: [JSON] = []
    @State private var room: String?
    @State private var q = ""
    @State private var loading = true
    @State private var problem: String?
    @State private var token: UUID?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.l) {
                PageHead(eyebrow: "Memory", title: about["label"].string ?? "What Vyre knows", sub: sub)
                SearchField(text: $q, prompt: "About alex, Harlow Legal", submit: { Task { await load() } })
                if !projects.isEmpty {
                    HStack(spacing: Space.s) {
                        Engraved("Room")
                        Picker("Room", selection: $room) {
                            Text("Everything").tag(String?.none)
                            ForEach(projects, id: \.self) { p in Text(p["name"].string ?? p["slug"].text).tag(Optional(p["slug"].text)) }
                        }
                        .pickerStyle(.menu)
                        .tint(Color.bone)
                        Spacer()
                    }
                }
                VStack(alignment: .leading, spacing: 0) {
                    SectionHead(title: q.isEmpty ? "Facts" : "Facts about \(q)", note: facts.isEmpty ? nil : "\(facts.count)", color: .recall)
                        .padding(.bottom, Space.s)
                    Hairline()
                    LoadState(loading: loading && facts.isEmpty, problem: problem,
                              empty: facts.isEmpty ? (q.isEmpty ? "Nothing learned yet." : "Memory knows nothing about \(q).") : nil)
                    ForEach(facts, id: \.self) { f in
                        NavigationLink(value: MoreDest.fact(f["id"].text)) { FactRow(fact: f) }.buttonStyle(.plain)
                    }
                }
                Text("To correct, merge or split a fact, use the Deck. A phone can read, pin and mute.")
                    .vyre(.small).foregroundStyle(Color.ash)
            }
            .padding(.horizontal, Space.gutter)
            .padding(.bottom, Space.xxl)
        }
        .scrollDismissesKeyboard(.interactively)
        .refreshable { await load() }
        .vyreGround()
        .navigationBarTitleDisplayMode(.inline)
        .vyreNavBar()
        .task(id: room) { await load() }
        .task {
            if let p = try? await app.call("projects.list") { projects = p["projects"].list }
            if let s = try? await app.call("memory.stats") { stats = s }
        }
        .onAppear {
            guard token == nil else { return }
            token = app.hub.on { e in if e.type == "memory.curated" { Task { await load() } } }
        }
        .onDisappear { app.hub.off(token); token = nil }
    }

    private var sub: String? {
        if about["label"].string != nil {
            return [about["kind"].string, about["mentions"].int.map { plural($0, "mention") }, about["pinned"].bool == true ? "pinned" : nil,
                    about["muted"].bool == true ? "muted" : nil].compactMap { $0 }.joined(separator: " · ")
        }
        let n = stats["facts"].int ?? stats["edges"].int
        let nodes = stats["nodes"].int
        guard n != nil || nodes != nil else { return nil }
        return [n.map { plural($0, "fact") }, nodes.map { plural($0, "thing") }].compactMap { $0 }.joined(separator: " about ")
    }

    private func load() async {
        loading = true
        defer { loading = false }
        var input: JSON = ["limit": 100]
        let s = q.trimmingCharacters(in: .whitespacesAndNewlines)
        if !s.isEmpty { input = input.with("about", .string(s)) }
        if let room { input = input.with("room", .string(room)) }
        do {
            let out = try await app.call("memory.facts", input)
            facts = out["facts"].list
            about = out["about"]
            problem = nil
        } catch {
            facts = []
            problem = describe(error)
        }
    }
}

/// A fact as one line: its sentence, how sure, how fresh.
struct FactRow: View {
    let fact: JSON
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Space.m) {
            Dot(color: fact["stale"].bool == true ? .ash : .recall)
            VStack(alignment: .leading, spacing: 2) {
                Text(fact["text"].text).vyre(.body).foregroundStyle(fact["stale"].bool == true ? Color.stone : Color.bone)
                Text([fact["age"].string, fact["confidence"].double.map { "\(Int($0 * 100))% sure" },
                      fact["conflict"].bool == true ? "conflicts" : nil, fact["origin"].string == "user" ? "you said" : nil]
                    .compactMap { $0 }.joined(separator: " · "))
                    .vyre(.codeSmall).foregroundStyle(Color.ash)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right").font(.system(size: 12, weight: .medium)).foregroundStyle(Color.ash)
        }
        .padding(.vertical, Space.m)
        .contentShape(Rectangle())
        .overlay(alignment: .bottom) { Hairline() }
    }
}

/// Why a fact is known: the turns it came from and what taught it. Pin or mute its subject.
struct FactView: View {
    @Environment(AppModel.self) private var app
    let id: String
    @State private var why: JSON = .null
    @State private var loading = true
    @State private var problem: String?
    @State private var line: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.xl) {
                let f = why["fact"]
                VStack(alignment: .leading, spacing: Space.s) {
                    Engraved("Fact", color: .recall)
                    Text(f["text"].string ?? f["label"].string ?? id).vyre(.h2).foregroundStyle(Color.bone)
                    Text([f["age"].string, f["confidence"].double.map { "\(Int($0 * 100))% sure" }, f["source"].string].compactMap { $0 }.joined(separator: " · "))
                        .vyre(.codeSmall).foregroundStyle(Color.ash)
                }
                LoadState(loading: loading, problem: problem, empty: nil)
                if let subject = f["subject"]["id"].string {
                    VStack(alignment: .leading, spacing: Space.s) {
                        HStack(spacing: Space.s) {
                            Button("Pin \(f["subject"]["label"].string ?? "it")") { Task { await mark("memory.pin", subject) } }.buttonStyle(.secondary)
                            Button("Mute") { Task { await mark("memory.mute", subject) } }.buttonStyle(.quiet)
                        }
                        if let line { Text(line).vyre(.small).foregroundStyle(Color.stone) }
                    }
                }
                turns
                taught
            }
            .padding(.horizontal, Space.gutter)
            .padding(.bottom, Space.xxl)
        }
        .vyreGround()
        .navigationBarTitleDisplayMode(.inline)
        .vyreNavBar()
        .task { await load() }
    }

    @ViewBuilder
    private var turns: some View {
        let list = why["turns"].list
        VStack(alignment: .leading, spacing: 0) {
            SectionHead(title: "Said in", note: list.isEmpty ? nil : "\(list.count)").padding(.bottom, Space.s)
            Hairline()
            if list.isEmpty && !loading { EmptyLine(text: "No turn is kept for this fact.") }
            ForEach(list, id: \.self) { t in
                Button { if let s = t["session"].string { app.open(.thread(s)) } } label: {
                    VStack(alignment: .leading, spacing: Space.xs) {
                        HStack {
                            Engraved(t["role"].string ?? "turn")
                            Text(t["name"].string ?? "").vyre(.codeSmall).foregroundStyle(Color.stone).lineLimit(1)
                            Spacer()
                            Text(t["age"].string ?? "").vyre(.codeSmall).foregroundStyle(Color.ash)
                        }
                        Text(t["text"].text).vyre(.small).foregroundStyle(Color.bone).lineLimit(6)
                    }
                    .padding(.vertical, Space.m)
                    .contentShape(Rectangle())
                    .overlay(alignment: .bottom) { Hairline() }
                }
                .buttonStyle(.plain)
            }
            if let g = why["gone"].int, g > 0 { Engraved("\(plural(g, "turn")) no longer kept").padding(.top, Space.s) }
        }
    }

    @ViewBuilder
    private var taught: some View {
        let list = why["taught"].list
        if !list.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                SectionHead(title: "Taught by").padding(.bottom, Space.s)
                Hairline()
                ForEach(list, id: \.self) { t in
                    ListRow(title: t["text"].string ?? t["key"].text, detail: [t["module"].string, t["kind"].string].compactMap { $0 }.joined(separator: " · "),
                            note: t["age"].string, chevron: false)
                }
            }
        }
    }

    private func load() async {
        defer { loading = false }
        do { why = try await app.call("memory.why", ["fact": .string(id)]); problem = nil }
        catch { problem = describe(error) }
    }

    private func mark(_ tool: String, _ node: String) async {
        do {
            let out = try await app.call(tool, ["node": .string(node), "scope": "*"])
            let mode = out["mode"].string
            line = mode == nil ? "\(out["label"].string ?? "It") is neither pinned nor muted." : "\(out["label"].string ?? "It") is \(mode == "pin" ? "pinned" : "muted")."
        } catch { line = describe(error) }
    }
}
