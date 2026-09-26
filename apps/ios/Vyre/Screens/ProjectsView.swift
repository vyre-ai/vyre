import SwiftUI

/// Projects (a tab): the project list, and each project's page with its sessions. The Deck's
/// views/projects.js and the Android ProjectsScreen. The list is kept for offline reading.
struct ProjectsHome: View {
    @Environment(AppModel.self) private var app
    @State private var path: [Dest] = []
    @State private var projects: [JSON] = []
    @State private var loading = true
    @State private var problem: String?
    @State private var cached = false

    var body: some View {
        NavigationStack(path: $path) {
            PullScroll {
                VStack(alignment: .leading, spacing: Space.xl) {
                    VStack(alignment: .leading, spacing: 0) {
                        BrandBar()
                        PageHead(title: "Projects", sub: cached ? "Offline. The projects this phone kept." : nil)
                    }
                    VStack(alignment: .leading, spacing: 0) {
                        SectionHead(title: "Projects", note: "\(projects.count)").padding(.bottom, Space.s)
                        Hairline()
                        LoadState(loading: loading && projects.isEmpty, problem: projects.isEmpty ? problem : nil,
                                  empty: projects.isEmpty ? "No projects yet. Make one on the Mac with vyre new." : nil)
                        ForEach(projects, id: \.self) { p in
                            NavigationLink(value: Dest.project(slug: p["slug"].text, name: p["name"].string ?? p["slug"].text)) {
                                ListRow(title: p["name"].string ?? p["slug"].text,
                                        detail: [p["org"].string, p["threads"].int.map { plural($0, "session") }].compactMap { $0 }.joined(separator: " · "),
                                        note: age(p["last"].double))
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
    }

    private func load() async {
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

/// One project's sessions: picked and in its folders (`projects.threads`), and a new session there.
struct ProjectView: View {
    @Environment(AppModel.self) private var app
    let slug: String
    let name: String
    @State private var sessions: [JSON] = []
    @State private var loading = true
    @State private var problem: String?
    @State private var starting = false

    var body: some View {
        PullScroll {
            VStack(alignment: .leading, spacing: Space.l) {
                PageHead(eyebrow: "Project", title: name)
                VStack(alignment: .leading, spacing: 0) {
                    SectionHead(title: "Sessions", note: sessions.isEmpty ? nil : "\(sessions.count)").padding(.bottom, Space.s)
                    Hairline()
                    LoadState(loading: loading && sessions.isEmpty, problem: problem, empty: sessions.isEmpty ? "No sessions in this project yet." : nil)
                    ForEach(sessions, id: \.self) { s in
                        NavigationLink(value: Dest.thread(s["id"].text)) {
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
                if let id { app.open(.thread(id)) }
            }
        }
        .task { await load() }
    }

    private func load() async {
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

