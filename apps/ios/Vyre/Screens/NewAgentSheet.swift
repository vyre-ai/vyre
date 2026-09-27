import SwiftUI

/// New agent (the "+" on Agents): the Deck's New agent form (deck/views/agents.js newForm) as a
/// sheet. Name, the projects it works in, its job, what it runs on (Vault items picked by name,
/// never a value typed here), and a computer. Making an agent needs no Face ID (a person caller is
/// enough); should a box still answer `presence_required`, the call signs once and retries once.
struct NewAgentSheet: View {
    @Environment(AppModel.self) private var app
    @State private var name = ""
    @State private var job = ""
    @State private var projects: [JSON] = []
    @State private var picked: Set<String> = []
    @State private var vaultNames: [String] = []
    @State private var runsOn: RunsOn = .subscription
    @State private var subItem = NewAgentSheet.defaultSub
    @State private var keyItem = NewAgentSheet.defaultKey
    @State private var fallback = true
    @State private var budget = "10"
    @State private var computer = false
    @State private var busy = false
    @State private var problem: String?

    enum RunsOn: String, CaseIterable, Identifiable {
        case subscription, apiKey
        var id: String { rawValue }
        var label: String { self == .subscription ? "Subscription" : "API key" }
    }

    static let defaultSub = "claude-setup-token"
    static let defaultKey = "anthropic-api-key"

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.l) {
                    field("Name", hint: "Lowercase, one word. It signs its threads with it.") {
                        TextField("", text: $name, prompt: Text("e.g. rex").foregroundStyle(Color.label))
                            .vyre(.input).foregroundStyle(Color.text)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .padding(.horizontal, Space.m).frame(minHeight: Space.target)
                            .background(Color.bg, in: RoundedRectangle(cornerRadius: Radius.card))
                            .overlay { RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Color.ruleStrong, lineWidth: 1) }
                    }
                    field("Works in", hint: projects.isEmpty ? "No projects yet. It will see none until you add some." : "It never sees projects outside this list.") {
                        if !projects.isEmpty {
                            Card {
                                ForEach(Array(projects.enumerated()), id: \.element) { i, p in
                                    if i > 0 { Hairline() }
                                    let slug = p["slug"].text
                                    Toggle(isOn: Binding(get: { picked.contains(slug) }, set: { on in if on { picked.insert(slug) } else { picked.remove(slug) } })) {
                                        Text(p["name"].string ?? slug).vyre(.secondary).foregroundStyle(Color.text)
                                    }
                                    .tint(Color.focus)
                                    .padding(.horizontal, 14).frame(minHeight: Space.target)
                                }
                            }
                        }
                    }
                    field("Job", hint: nil) {
                        TextField("", text: $job, prompt: Text("What this agent does, and what it must ask you before doing.").foregroundStyle(Color.label), axis: .vertical)
                            .vyre(.input).foregroundStyle(Color.text)
                            .lineLimit(3...8)
                            .padding(Space.m)
                            .background(Color.bg, in: RoundedRectangle(cornerRadius: Radius.card))
                            .overlay { RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Color.ruleStrong, lineWidth: 1) }
                    }
                    field("Runs on", hint: runsOn == .subscription ? "Uses your plan. The token stays in the Vault." : "Stops when the budget is spent.") {
                        Picker("Runs on", selection: $runsOn) {
                            ForEach(RunsOn.allCases) { Text($0.label).tag($0) }
                        }
                        .pickerStyle(.segmented)
                        Card {
                            if runsOn == .subscription {
                                vaultRow("Vault item", $subItem)
                                Hairline()
                                Toggle(isOn: $fallback) {
                                    Text("At the limit, fall back to an API key").vyre(.secondary).foregroundStyle(Color.text)
                                }
                                .tint(Color.focus)
                                .padding(.horizontal, 14).frame(minHeight: Space.target)
                                if fallback {
                                    Hairline()
                                    vaultRow("Key item", $keyItem)
                                    Hairline()
                                    budgetRow
                                }
                            } else {
                                vaultRow("Vault item", $keyItem)
                                Hairline()
                                budgetRow
                            }
                        }
                    }
                    Card {
                        Toggle(isOn: $computer) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Its own computer").vyre(.secondary).foregroundStyle(Color.text)
                                Text("From the pool.").vyre(.small).foregroundStyle(Color.label)
                            }
                        }
                        .tint(Color.focus)
                        .padding(.horizontal, 14).frame(minHeight: 52)
                    }
                    if let problem { FailedLine(text: problem) }
                    Button { Task { await create() } } label: { Text(busy ? "Creating" : "Create agent") }
                        .buttonStyle(.vyre(.primary, large: true))
                        .disabled(busy)
                }
                .padding(.horizontal, 20)
                .padding(.vertical, Space.gutter)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Color.panel)
            .navigationTitle("New agent")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { app.sheet = nil } } }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .task { await load() }
    }

    @ViewBuilder
    private func field<C: View>(_ label: String, hint: String?, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: Space.s) {
            Text(label).vyre(.label).foregroundStyle(Color.label).accessibilityAddTraits(.isHeader)
            content()
            if let hint { Text(hint).vyre(.small).foregroundStyle(Color.label) }
        }
    }

    /// A Vault item, picked from `vault.list`'s names. The default is offered even when the list
    /// lacks it, so a box whose vault is locked still gets the Deck's default.
    private func vaultRow(_ label: String, _ value: Binding<String>) -> some View {
        HStack {
            Text(label).vyre(.secondary).foregroundStyle(Color.label)
            Spacer()
            Picker(label, selection: value) {
                ForEach(names(including: value.wrappedValue), id: \.self) { Text($0).tag($0) }
            }
            .pickerStyle(.menu)
            .tint(Color.text)
        }
        .padding(.leading, 14).padding(.trailing, Space.s).frame(minHeight: Space.target)
    }

    private var budgetRow: some View {
        HStack {
            Text("Budget a month").vyre(.secondary).foregroundStyle(Color.label)
            Spacer()
            Text("$").vyre(.secondary).foregroundStyle(Color.label)
            TextField("", text: $budget).keyboardType(.numberPad).multilineTextAlignment(.trailing)
                .vyre(.input).foregroundStyle(Color.text).frame(width: 72)
                .accessibilityLabel("Monthly budget in US dollars")
        }
        .padding(.horizontal, 14).frame(minHeight: Space.target)
    }

    private func names(including v: String) -> [String] {
        var out = vaultNames
        if !out.contains(v) { out.insert(v, at: 0) }
        return out
    }

    private func load() async {
        if let p = try? await app.call("projects.list") { projects = p["projects"].list }
        else if let c = app.cache.get("projects.list") { projects = c["projects"].list }
        if let v = try? await app.call("vault.list") { vaultNames = v["items"].list.compactMap { $0["name"].string }.sorted() }
    }

    /// The Deck's input for `agents.create`, after the same checks.
    static func input(name: String, projects: [String], job: String, runsOn: RunsOn, subItem: String, keyItem: String,
                      fallback: Bool, budget: String, computer: Bool, haveProjects: Bool) -> Result<JSON, CreateError> {
        let n = name.trimmingCharacters(in: .whitespaces)
        if n.range(of: #"^[a-z][a-z0-9-]{0,31}$"#, options: .regularExpression) == nil { return .failure(.name) }
        if haveProjects && projects.isEmpty { return .failure(.projects) }
        let b = Double(budget.trimmingCharacters(in: .whitespaces)) ?? 0
        var auth: [String: JSON] = runsOn == .subscription ? ["vault": .string(subItem)] : ["vault": .string(keyItem), "budget_usd": .number(b)]
        if runsOn == .subscription && fallback { auth["fallback"] = .string(keyItem); auth["budget_usd"] = .number(b) }
        if auth["budget_usd"] != nil && !(b > 0) { return .failure(.budget) }
        return .success(["name": .string(n), "kind": "agent", "projects": JSON(projects.sorted()), "instructions": .string(job.trimmingCharacters(in: .whitespacesAndNewlines)),
                         "auth": .object(auth), "computer": .bool(computer)])
    }

    enum CreateError: Error, Equatable {
        case name, projects, budget
        var text: String {
            switch self {
            case .name: "A name is lowercase letters, digits and dashes, starting with a letter."
            case .projects: "Pick at least one project. An agent never sees projects outside its list."
            case .budget: "The budget is a number of dollars above zero."
            }
        }
    }

    private func create() async {
        problem = nil
        let built = NewAgentSheet.input(name: name, projects: Array(picked), job: job, runsOn: runsOn, subItem: subItem, keyItem: keyItem,
                                        fallback: fallback, budget: budget, computer: computer, haveProjects: !projects.isEmpty)
        let input: JSON
        switch built {
        case .failure(let e): problem = e.text; return
        case .success(let j): input = j
        }
        busy = true
        defer { busy = false }
        do {
            let n = input["name"].text
            _ = try await app.callProvingIfAsked("agents.create", input, reason: "Create agent \(n)")
            Haptics.success()
            app.agentsVersion += 1
            app.sheet = nil
            app.page = .agents
        } catch where isCancel(error) {
        } catch {
            problem = describe(error) + " The agent was not created."
        }
    }
}
