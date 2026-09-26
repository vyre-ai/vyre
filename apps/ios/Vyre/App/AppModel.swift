import Observation
import SwiftUI
import UIKit

/// The five tabs, the phone PWA's order (docs/work/pwa.md): Now, Projects, Chat, Find, Agents.
enum Tab: String, Hashable, CaseIterable { case now, projects, chat, find, agents }

/// Graphite (dark) by default, then Paper, then whatever the phone uses (TOKENS.md: dark is the default).
enum Theme: String, CaseIterable, Identifiable {
    case dark, paper, system
    var id: String { rawValue }
    var scheme: ColorScheme? { switch self { case .system: nil; case .dark: .dark; case .paper: .light } }
    var label: String { switch self { case .system: "Like the phone"; case .dark: "Graphite"; case .paper: "Paper" } }
}

/// Where a tap on a notification (or a DEBUG launch argument) sends the app.
enum Route: Equatable {
    case needs(String)
    case thread(String)
    /// Settings, pushed on Now (the avatar's screen).
    case settings
    /// The Vault and Memory pages, pushed on Find (its Places).
    case vault
    case memory

    /// `/needs/<id>`, `/threads/<id>`, `/settings...`: the only paths a push carries. `/vault` and
    /// `/memory` are links inside the app.
    init?(path: String) {
        let parts = path.split(separator: "/").map(String.init)
        guard let first = parts.first else { return nil }
        switch first {
        case "needs" where parts.count > 1: self = .needs(parts[1])
        case "threads" where parts.count > 1: self = .thread(parts[1])
        case "vault": self = .vault
        case "memory": self = .memory
        default:
            if first.hasPrefix("settings") { self = .settings } else { return nil }
        }
    }
}

/// The app's state: which box, this phone's key, the one client and the one event stream.
@MainActor
@Observable
final class AppModel {
    enum Phase: Equatable { case setup, ready }

    static let addressAccount = "box-address"
    static let enrolledAccount = "enrolled-key"

    private(set) var phase: Phase = .setup
    private(set) var address: BoxAddress?
    private(set) var key: DeviceKey?
    private(set) var enrolledId: String?
    private(set) var client: VyreClient?
    let hub = EventHub()
    let sessions = PresenceSessions()
    let cache = OfflineCache()
    let needs: NeedsStore
    let push = PushClient()

    var tab: Tab = .now
    var route: Route?
    var theme: Theme {
        didSet { UserDefaults.standard.set(theme.rawValue, forKey: "theme") }
    }
    /// A reachable box: false after a request failed with `offline`, true after one succeeded.
    var online = true
    /// Vault values are on screen: blur the app when it leaves the front.
    var secretOnScreen = false
    var inFront = true

    init() {
        theme = Theme(rawValue: UserDefaults.standard.string(forKey: "theme") ?? "") ?? .dark
        needs = NeedsStore()
        #if DEBUG
        if let t = Launch.value("-VyreTheme"), let th = Theme(rawValue: t) { theme = th }
        #endif
        restore()
    }

    private func restore() {
        guard let raw = Keychain.get(AppModel.addressAccount).map({ String(decoding: $0, as: UTF8.self) }),
              let addr = BoxAddress(raw), let key = DeviceKey.load(),
              let enrolled = Keychain.get(AppModel.enrolledAccount).map({ String(decoding: $0, as: UTF8.self) }),
              enrolled == key.id else { return }
        activate(address: addr, key: key)
    }

    private func activate(address: BoxAddress, key: DeviceKey) {
        self.address = address
        self.key = key
        self.enrolledId = key.id
        client = VyreClient(address: address, signer: DevicePresence(key: key, sessions: sessions))
        needs.attach(self)
        phase = .ready
    }

    /// Finish setup: remember the box and the key the box enrolled.
    func signedIn(address: BoxAddress, key: DeviceKey, id: String) throws {
        try Keychain.set(Data(address.url.absoluteString.utf8), for: AppModel.addressAccount)
        try Keychain.set(Data(id.utf8), for: AppModel.enrolledAccount)
        activate(address: address, key: key)
        becameActive()
    }

    /// Sign out: remove the key from the box, then wipe the key, the cache and the push key.
    func signOut() async {
        if let client, let key {
            _ = try? await client.call("presence.remove", ["id": .string(key.id)], proof: .device(reason: "Sign this phone out of Vyre"))
        }
        await push.unregister(client: client)
        wipe()
    }

    func wipe() {
        hub.stop()
        DeviceKey.delete()
        Keychain.delete(AppModel.addressAccount)
        Keychain.delete(AppModel.enrolledAccount)
        PushKeyStore.delete()
        cache.wipe()
        Task { await sessions.set(nil) }
        client = nil
        key = nil
        address = nil
        enrolledId = nil
        needs.clear()
        phase = .setup
    }

    // MARK: foreground and background

    /// The app came to the front: read health's last_event, open the one stream, refresh needs.
    func becameActive() {
        inFront = true
        guard let client else { return }
        Task {
            var since: Int?
            do {
                let h = try await client.health()
                since = h["last_event"].int
                online = true
            } catch { online = false }
            if hub.lastEventId != nil { since = nil }
            hub.start(client: client, since: since)
            await needs.refresh()
        }
    }

    /// Left the screen: close the stream within a second and end any presence session.
    func resignedActive() {
        inFront = false
        hub.stop()
        Task { await sessions.set(nil) }
    }

    /// Run a tool call; `offline` failures flip the offline banner.
    func call(_ tool: String, _ input: JSON = [:], proof: Proof = .none) async throws -> JSON {
        guard let client else { throw VyreError.offline("Not signed in.") }
        do {
            let out = try await client.call(tool, input, proof: proof)
            online = true
            return out
        } catch let e as VyreError {
            if case .offline = e { online = false }
            throw e
        }
    }

    func open(_ route: Route) {
        switch route {
        case .needs, .settings: tab = .now
        case .thread: tab = .chat
        case .vault, .memory: tab = .find
        }
        self.route = route
    }

    func handle(url: URL) {
        // vyre://threads/<id>, vyre://needs/<id>
        guard url.scheme == "vyre", let host = url.host else { return }
        if let r = Route(path: "/" + host + url.path) { open(r) }
    }
}

#if DEBUG
/// DEBUG-only launch arguments for the test world and screenshots:
/// `-VyreTestBox http://127.0.0.1:4800` skips the QR and enrolls with a code the test world mints;
/// `-VyreTab now|projects|chat|find|agents`, `-VyreTheme dark|paper|system`,
/// `-VyreOpen /threads/<id>|/needs/<id>|/settings|/vault|/memory`.
enum Launch {
    static func value(_ flag: String) -> String? {
        let a = ProcessInfo.processInfo.arguments
        guard let i = a.firstIndex(of: flag), i + 1 < a.count else { return nil }
        return a[i + 1]
    }
    static func has(_ flag: String) -> Bool { ProcessInfo.processInfo.arguments.contains(flag) }
}
#endif

/// "18 min", "4 days": the boards' age, as local/capsule/lib/route.js writes it.
func age(_ ms: Double?, now: Date = Date()) -> String {
    guard let ms, ms > 0 else { return "" }
    let s = max(0, Int((now.timeIntervalSince1970 * 1000 - ms) / 1000))
    if s < 60 { return "now" }
    let m = Int((Double(s) / 60).rounded())
    if m < 60 { return "\(m) min" }
    let h = Int((Double(m) / 60).rounded())
    if h < 24 { return "\(h) h" }
    let d = Int((Double(h) / 24).rounded())
    if d < 14 { return d == 1 ? "1 day" : "\(d) days" }
    let w = Int((Double(d) / 7).rounded())
    return w < 9 ? "\(w) weeks" : "\(Int((Double(d) / 30).rounded())) months"
}

enum Haptics {
    @MainActor static func success() { UINotificationFeedbackGenerator().notificationOccurred(.success) }
    @MainActor static func warning() { UINotificationFeedbackGenerator().notificationOccurred(.warning) }
    @MainActor static func tap() { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
}
