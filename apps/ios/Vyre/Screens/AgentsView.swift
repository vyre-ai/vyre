import SwiftUI

/// Agents (a tab, as in the PWA): the assistant first, then each agent, what it is doing and what
/// it costs (`agents.list`, `agents.usage`); each opens its page. The Deck's views/agents.js.
struct AgentsHome: View {
    @Environment(AppModel.self) private var app
    @State private var agents: [JSON] = []
    @State private var usage: [JSON] = []
    @State private var loading = true
    @State private var problem: String?
    @State private var cached = false
    @State private var path: [Dest] = []
    @State private var token: UUID?

    var body: some View {
        NavigationStack(path: $path) {
            PullScroll {
                VStack(alignment: .leading, spacing: Space.l) {
                    VStack(alignment: .leading, spacing: 0) {
                        BrandBar()
                        PageHead(title: "Agents", sub: cached ? "Offline. The list this phone kept." : nil)
                    }
                    VStack(alignment: .leading, spacing: 0) {
                        Hairline()
                        LoadState(loading: loading && agents.isEmpty, problem: agents.isEmpty ? problem : nil,
                                  empty: agents.isEmpty ? "No agents yet. The assistant appears once the box has one." : nil)
                        ForEach(agents, id: \.self) { a in
                            let name = a["name"].text
                            NavigationLink(value: Dest.agent(name)) {
                                ListRow(title: name,
                                        detail: [a["kind"].string == "assistant" ? "Assistant" : nil, a["doing"].string, modelLabel(a["model"].string)].compactMap { $0 }.joined(separator: " · "),
                                        note: spend(name),
                                        dot: statusDot(a["status"].string == "new" ? nil : a["status"].string))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .padding(.horizontal, Space.gutter)
                .padding(.bottom, Space.xxl)
            }
            .vyreGround()
            .toolbar(.hidden, for: .navigationBar)
            .vyreDestinations()
        }
        .task { await load() }
        .onAppear {
            guard token == nil else { return }
            let watched: Set<String> = ["thread.started", "thread.finished", "thread.stopped", "ask.raised", "ask.answered"]
            token = app.hub.on { e in if watched.contains(e.type) { Task { await load() } } }
        }
    }

    private func spend(_ name: String) -> String? {
        guard let u = usage.first(where: { $0["agent"].string == name }), let c = u["cost_usd"].double, c > 0 else { return nil }
        return String(format: "$%.2f", c)
    }

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
        if let u = try? await app.call("agents.usage") { usage = u.list }
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
                Text(v).vyre(.code).foregroundStyle(Color.bone)
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
                    Text(line).vyre(.small).foregroundStyle(Color.stone)
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
                        Text(age(h["at"].double)).vyre(.codeSmall).foregroundStyle(Color.ash)
                    }
                    Text(h["text"].text).vyre(.small).foregroundStyle(Color.bone).lineLimit(3)
                    if let a = h["answer"].string, !a.isEmpty { Text(a).vyre(.small).foregroundStyle(Color.stone).lineLimit(4) }
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
