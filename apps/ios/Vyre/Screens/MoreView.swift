import SwiftUI

enum MoreDest: Hashable {
    case agents, memory, vault, settings
    case agent(String)
    case fact(String)
    case vaultItem(String)

    init?(section: String) {
        switch section.lowercased() {
        case "agents": self = .agents
        case "memory": self = .memory
        case "vault": self = .vault
        case "settings": self = .settings
        default: return nil
        }
    }
}

/// More: Agents, Memory, Vault and Settings, each a pushed screen. `-VyreMore <section>` (DEBUG)
/// and a push to `/settings` open one directly.
struct MoreView: View {
    @Environment(AppModel.self) private var app
    @State private var path: [MoreDest] = []

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.l) {
                    PageHead(eyebrow: app.address?.display, title: "More")
                    VStack(alignment: .leading, spacing: 0) {
                        Hairline()
                        link(.agents, "Agents", "Who works for you, what each is doing, what it cost.", "person.2")
                        link(.memory, "Memory", "What Vyre knows, and where it learned it.", "circle.hexagongrid")
                        link(.vault, "Vault", "Names and hosts. A value shows only after Face ID.", "lock")
                        link(.settings, "Settings", "Theme, the box, notifications, sign out.", "gearshape")
                    }
                }
                .padding(.horizontal, Space.gutter)
                .padding(.bottom, Space.xxl)
            }
            .vyreGround()
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: MoreDest.self) { d in
                switch d {
                case .agents: AgentsView()
                case .agent(let name): AgentDetailView(name: name)
                case .memory: MemoryView()
                case .fact(let id): FactView(id: id)
                case .vault: VaultView()
                case .vaultItem(let name): VaultItemView(name: name)
                case .settings: SettingsView()
                }
            }
        }
        .onChange(of: app.route, initial: true) { _, r in
            if case .more(let s) = r, let d = MoreDest(section: s) {
                path = [d]
                app.route = nil
            }
        }
        #if DEBUG
        .onAppear {
            if path.isEmpty, let s = Launch.value("-VyreMore"), let d = MoreDest(section: s) {
                app.tab = .more
                path = [d]
            }
        }
        #endif
    }

    private func link(_ d: MoreDest, _ title: String, _ detail: String, _ icon: String) -> some View {
        NavigationLink(value: d) {
            HStack(spacing: Space.m) {
                Image(systemName: icon).font(.system(size: 17, weight: .light)).foregroundStyle(Color.stone).frame(width: 24)
                ListRow(title: title, detail: detail)
            }
        }
        .buttonStyle(.plain)
    }
}
