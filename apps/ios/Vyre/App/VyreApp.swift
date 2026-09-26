import SwiftUI

@main
struct VyreApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var app = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(app)
                .preferredColorScheme(app.theme.scheme)
                .onAppear { AppDelegate.model = app }
                .onOpenURL { app.handle(url: $0) }
                .onChange(of: scenePhase, initial: true) { _, phase in
                    switch phase {
                    case .active: app.becameActive()
                    case .background: app.resignedActive()
                    default: break
                    }
                }
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ZStack {
            switch app.phase {
            case .setup: FirstRunView()
            case .ready: MainTabs()
            }
            // A vault value is on screen and the app is leaving it: cover everything, so the app
            // switcher's snapshot shows nothing (ADR 0018 section 7).
            if app.secretOnScreen && scenePhase != .active {
                Color.ground.ignoresSafeArea()
                    .overlay { Mark(size: 48) }
                    .accessibilityHidden(true)
            }
        }
        .tint(Color.signal)
    }
}

/// The five tabs, the phone PWA's order: Now, Projects, Chat, Find, Agents. A custom bar in the
/// boards' language (mono labels, hairline above, no fill behind content). Every tab keeps its
/// own navigation stack alive while another is in front; pulling down from the top of a list
/// opens Find.
struct MainTabs: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        @Bindable var app = app
        VStack(spacing: 0) {
            ZStack {
                tab(.now) { NowView() }
                tab(.projects) { ProjectsHome() }
                tab(.chat) { ChatHome() }
                tab(.find) { FindView() }
                tab(.agents) { AgentsHome() }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            if !app.online { OfflineBar() }
            TabBar(selection: $app.tab, badge: app.needs.count)
        }
        .vyreGround()
        #if DEBUG
        .onAppear {
            if let t = Launch.value("-VyreTab"), let tab = Tab(rawValue: t) { app.tab = tab }
            if let p = Launch.value("-VyreOpen"), let r = Route(path: p) { app.open(r) }
        }
        #endif
    }

    @ViewBuilder
    private func tab<V: View>(_ t: Tab, @ViewBuilder _ content: () -> V) -> some View {
        let on = app.tab == t
        content()
            .opacity(on ? 1 : 0)
            .allowsHitTesting(on)
            .accessibilityHidden(!on)
    }
}

struct OfflineBar: View {
    var body: some View {
        HStack(spacing: Space.s) {
            Dot(color: .ash)
            Text("Offline. Showing what this phone kept.").vyre(.small).foregroundStyle(Color.stone)
            Spacer()
        }
        .padding(.horizontal, Space.gutter)
        .padding(.vertical, Space.s)
        .background(Color.panel)
        .overlay(alignment: .top) { Hairline() }
    }
}

struct TabBar: View {
    @Binding var selection: Tab
    let badge: Int

    var body: some View {
        HStack(alignment: .bottom, spacing: 0) {
            item(.now, "Now", "bell")
            item(.projects, "Projects", "list.bullet")
            item(.chat, "Chat", "bubble.left")
            item(.find, "Find", "magnifyingglass")
            item(.agents, "Agents", "person")
        }
        .padding(.horizontal, Space.s)
        .padding(.top, Space.s)
        .padding(.bottom, Space.xs)
        .background(Color.ground.ignoresSafeArea(edges: .bottom))
        .overlay(alignment: .top) { Hairline() }
    }

    private func item(_ t: Tab, _ label: String, _ icon: String) -> some View {
        let on = selection == t
        return Button {
            if selection != t { Haptics.tap() }
            selection = t
        } label: {
            VStack(spacing: 6) {
                ZStack(alignment: .topTrailing) {
                    Image(systemName: icon).font(.system(size: 19, weight: .light)).frame(height: 22)
                    if t == .now && badge > 0 {
                        Text(badge > 99 ? "99+" : "\(badge)").font(VyreFonts.base(.label).asFont(size: 10)).foregroundStyle(Color.signalInk)
                            .padding(.horizontal, 5).frame(minWidth: 16, minHeight: 16)
                            .background(Color.beaconDot, in: Capsule())
                            .offset(x: 12, y: -6)
                    }
                }
                // The PWA's tab labels: mono 10, +0.14em, uppercase.
                Text(label.uppercased()).font(VyreFonts.base(.label).asFont(size: 10)).tracking(1.4).lineLimit(1)
            }
            .foregroundStyle(on ? Color.bone : Color.ash)
            .frame(maxWidth: .infinity, minHeight: 52)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(t == .now && badge > 0 ? "\(label), \(badge) need you" : label)
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

extension UIFont {
    func asFont(size: CGFloat) -> Font { Font(withSize(size)) }
}
