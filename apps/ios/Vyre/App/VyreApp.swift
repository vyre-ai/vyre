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
            case .ready: MainShell()
            }
            // A vault value is on screen and the app is leaving it: cover everything, so the app
            // switcher's snapshot shows nothing (ADR 0018 section 7).
            if app.secretOnScreen && scenePhase != .active {
                Color.bg.ignoresSafeArea()
                    .overlay { Mark(size: 48) }
                    .accessibilityHidden(true)
            }
        }
        .tint(Color.focus)
        // Dynamic Type up to AX3 (phone.md section 12): past it, rows would stop fitting a phone.
        .dynamicTypeSize(...DynamicTypeSize.accessibility3)
    }
}

/// The shell (phone.md section 3): no tab bar. A 48 pt header with the mark, the three page
/// labels and the avatar; Now, Chats and Agents side by side, swiped or tapped; the Capsule
/// floating at the bottom, which opens Find as a sheet. Pushed screens (a chat, a held item, an
/// agent) slide in over the pages with a back chevron and the edge swipe.
struct MainShell: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        @Bindable var app = app
        NavigationStack(path: $app.path) {
            VStack(spacing: 0) {
                ShellHeader()
                if !app.online { OfflineLine() }
                TabView(selection: $app.page) {
                    NowView().tag(Page.now)
                    ChatHome().tag(Page.chats)
                    AgentsHome().tag(Page.agents)
                }
                .tabViewStyle(.page(indexDisplayMode: .never))
                // Pages leave 56 + 16 at the bottom so the last row clears the Capsule.
                .safeAreaInset(edge: .bottom, spacing: 0) { Color.clear.frame(height: 72) }
            }
            .overlay(alignment: .bottom) { CapsuleBar() }
            .vyreGround()
            .toolbar(.hidden, for: .navigationBar)
            .vyreDestinations()
        }
        .sheet(item: $app.sheet) { sheet in
            switch sheet {
            case .find:
                FindView()
                    .presentationDetents([.large])
                    .presentationDragIndicator(.visible)
                    .presentationBackground(Color.panel)
            case .newAgent:
                NewAgentSheet()
            case .settings:
                NavigationStack(path: $app.settingsPath) {
                    SettingsView()
                        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { app.sheet = nil } } }
                        .vyreDestinations()
                }
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
            }
        }
        .onChange(of: app.page) { _, _ in UISelectionFeedbackGenerator().selectionChanged() }
        #if DEBUG
        .onAppear {
            if let p = Launch.value("-VyrePage"), let page = Page(rawValue: p) { app.page = page }
            if let s = Launch.value("-VyreSheet"), let sheet = Sheet(rawValue: s) { app.sheet = sheet }
            if let p = Launch.value("-VyreOpen"), let r = Route(path: p) { app.open(r) }
        }
        #endif
    }
}

/// The header: the mark (Beacon dot when anything needs you), the page labels in Page type (the
/// current one in `--text`), and the avatar that opens Settings. On Agents the avatar's place
/// holds "+" for a new agent. It stays 48 tall; at large text sizes the labels shrink, then scroll.
struct ShellHeader: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        HStack(spacing: Space.m) {
            Mark(size: 22, needsYou: app.needs.count > 0)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Space.gutter) {
                    ForEach(Page.allCases, id: \.self) { p in
                        Button {
                            withAnimation(.snappy) { app.page = p }
                        } label: {
                            Text(p.label).vyre(.page)
                                .foregroundStyle(app.page == p ? Color.text : Color.label)
                                .lineLimit(1)
                                .minimumScaleFactor(0.8)
                                .frame(minHeight: Space.target)
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(app.page == p ? [.isSelected, .isHeader] : [])
                        .accessibilityLabel(p == .now && app.needs.count > 0 ? "\(p.label), \(app.needs.count) need you" : p.label)
                    }
                }
            }
            if app.page == .agents {
                Button { app.sheet = .newAgent } label: {
                    Image(systemName: "plus").font(.system(size: 20, weight: .regular)).foregroundStyle(Color.text)
                        .frame(width: Space.target, height: Space.target)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("New agent")
            } else {
                Button { app.sheet = .settings } label: { Avatar(name: app.ownerName, host: app.address?.host ?? "v") }
                    .buttonStyle(.plain)
            }
        }
        .padding(.leading, Space.gutter)
        .padding(.trailing, Space.s)
        .frame(height: 48)
        .background(Color.bg)
    }
}

/// Under the header when the box is out of reach (phone.md section 11).
struct OfflineLine: View {
    @Environment(AppModel.self) private var app
    @State private var since = Date()

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Space.s) {
            Text("Can't reach your box. Showing what it said at \(since.formatted(date: .omitted, time: .shortened)).")
                .vyre(.small).foregroundStyle(Color.text2)
            Spacer()
            Button("Retry") { app.becameActive() }.buttonStyle(.quiet)
        }
        .padding(.horizontal, Space.gutter)
        .overlay(alignment: .bottom) { Hairline() }
        .onAppear { since = Date() }
    }
}

/// The Capsule (phone.md section 3): floating 12 from each side, 56 tall (64 at accessibility
/// sizes), `--panel`, fully round. Tap or drag up opens Find; holding the mic would dictate, which
/// this build does not have yet, so it says so.
struct CapsuleBar: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dynamicTypeSize) private var dts
    @Environment(\.colorScheme) private var scheme
    @State private var micNote = false

    var body: some View {
        VStack(spacing: Space.s) {
            if micNote {
                Text("Dictation is not in this build yet. Type in Find instead.")
                    .vyre(.small).foregroundStyle(Color.text2)
                    .padding(.horizontal, Space.m).padding(.vertical, Space.s)
                    .background(Color.panel, in: RoundedRectangle(cornerRadius: Radius.panel))
                    .overlay { RoundedRectangle(cornerRadius: Radius.panel).strokeBorder(Color.ruleStrong, lineWidth: 1) }
                    .transition(.opacity)
            }
            HStack(spacing: Space.m) {
                Mark(size: 20, needsYou: false)
                Text("Ask \(app.assistantLabel), find, or run").vyre(.secondary).foregroundStyle(Color.label).lineLimit(1)
                Spacer(minLength: 0)
                Image(systemName: "mic").font(.system(size: 18, weight: .regular)).foregroundStyle(Color.label)
                    .frame(width: 40, height: 40)
                    .contentShape(Circle())
                    .onTapGesture { showMicNote() }
                    .onLongPressGesture(minimumDuration: 0.3) {
                        UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                        showMicNote()
                    }
                    .accessibilityElement()
                    .accessibilityLabel("Dictate, not available in this build")
                    .accessibilityAddTraits(.isButton)
            }
            .padding(.leading, Space.gutter)
            .padding(.trailing, Space.s)
            .frame(height: dts.isAccessibilitySize ? 64 : 56)
            .background(Color.panel, in: Capsule())
            .overlay { Capsule().strokeBorder(Color.ruleStrong, lineWidth: 1) }
            .shadow(color: .black.opacity(scheme == .dark ? 0.6 : 0.28), radius: 24, y: 12)
            .contentShape(Capsule())
            .onTapGesture { app.sheet = .find }
            .gesture(DragGesture(minimumDistance: 12).onEnded { v in if v.translation.height < -24 { app.sheet = .find } })
            .accessibilityElement(children: .contain)
            .accessibilityAction(named: "Find") { app.sheet = .find }
        }
        .padding(.horizontal, 12)
        .padding(.bottom, Space.xs)
        .accessibilityLabel("Capsule. Ask \(app.assistantLabel), find, or run")
    }

    private func showMicNote() {
        withAnimation { micNote = true }
        Task {
            try? await Task.sleep(for: .seconds(3))
            withAnimation { micNote = false }
        }
    }
}

extension UIFont {
    func asFont(size: CGFloat) -> Font { Font(withSize(size)) }
}
