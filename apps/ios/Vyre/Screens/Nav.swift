import SwiftUI

/// Every screen a tab can push, in one list, so any tab reaches any page (a Find result opens a
/// file, a fact or an agent; Now's avatar opens Settings, and Settings the Vault).
enum Dest: Hashable {
    case held(String)
    case project(slug: String, name: String)
    case thread(String)
    case agent(String)
    /// Memory, optionally about something (a Find search that went to memory).
    case memory(String?)
    case fact(String)
    case vault
    case vaultItem(String)
    case settings
    case file(JSON)
}

extension View {
    /// The one `navigationDestination` every tab's stack carries.
    func vyreDestinations() -> some View {
        navigationDestination(for: Dest.self) { DestView(dest: $0) }
    }
}

struct DestView: View {
    @Environment(AppModel.self) private var app
    let dest: Dest

    var body: some View {
        switch dest {
        case .held(let id):
            if let d = app.needs.held.first(where: { $0.id == id }) { HeldDetailView(draft: d) }
            else { GoneView(text: "This is no longer held. It was sent, discarded, or answered somewhere else.") }
        case .project(let slug, let name): ProjectView(slug: slug, name: name)
        case .thread(let id): ThreadView(id: id)
        case .agent(let name): AgentDetailView(name: name)
        case .memory(let about): MemoryView(initial: about ?? "")
        case .fact(let id): FactView(id: id)
        case .vault: VaultView()
        case .vaultItem(let name): VaultItemView(name: name)
        case .settings: SettingsView()
        case .file(let f): FilePreview(file: f)
        }
    }
}

/// A ScrollView that opens Find when pulled down from its top (the PWA's pullToFind): past 72 pt
/// it says "Release to find", and letting go opens the Find tab. Every list screen uses it.
struct PullScroll<Content: View>: View {
    @Environment(AppModel.self) private var app
    var enabled = true
    @ViewBuilder var content: Content
    @State private var pull: CGFloat = 0
    @State private var armed = false
    @State private var space = UUID()

    static var threshold: CGFloat { 72 }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                GeometryReader { g in
                    Color.clear.onChange(of: g.frame(in: .named(space)).minY) { _, y in track(y) }
                }
                .frame(height: 0)
                content
            }
        }
        .coordinateSpace(.named(space))
        .overlay(alignment: .top) {
            if enabled && pull > 8 {
                VStack(spacing: 0) {
                    Engraved(armed ? "Release to find" : "Pull to find", color: armed ? .bone : .ash)
                        .frame(maxWidth: .infinity, minHeight: min(pull, 44))
                    Hairline()
                }
                .background(Color.ground)
                .accessibilityHidden(true)
            }
        }
    }

    private func track(_ y: CGFloat) {
        guard enabled else { return }
        pull = max(0, y)
        if y >= PullScroll.threshold && !armed {
            armed = true
            Haptics.tap()
        } else if armed && y < 4 {
            // Let go past the line: the scroll view bounced back to rest.
            armed = false
            pull = 0
            app.tab = .find
        }
    }
}

/// The head of every tab, as the PWA draws it: mark and wordmark left, something on the right.
struct BrandBar<Trailing: View>: View {
    @Environment(AppModel.self) private var app
    @ViewBuilder var trailing: Trailing

    var body: some View {
        HStack(spacing: Space.s) {
            Mark(size: 20, needsYou: app.needs.count > 0)
            Wordmark(height: 20)
            Spacer()
            trailing
        }
        .frame(minHeight: Space.target)
        .padding(.top, Space.xs)
    }
}

extension BrandBar where Trailing == EmptyView {
    init() { self.init(trailing: { EmptyView() }) }
}

/// The person's circle at the right of Now's head: it opens Settings.
struct Avatar: View {
    let name: String?
    let host: String
    var body: some View {
        Text(initials(name: name, host: host))
            .vyre(.label)
            .foregroundStyle(Color.bone)
            .frame(width: 32, height: 32)
            .background(Color.panel, in: Circle())
            .overlay { Circle().strokeBorder(Color.ruleStrong, lineWidth: 1) }
            .frame(width: Space.target, height: Space.target)
            .contentShape(Rectangle())
            .accessibilityLabel("Settings")
    }
}
