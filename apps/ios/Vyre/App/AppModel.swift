import Observation
import SwiftUI
import UIKit

/// The three pages, side by side under the header (docs/design/phone.md section 3). Find is not a
/// page: it is the Capsule, opened as a sheet.
enum Page: String, Hashable, CaseIterable {
    case now, chats, agents
    var label: String { switch self { case .now: "Now"; case .chats: "Chats"; case .agents: "Agents" } }
}

/// The sheets over the pages: Find (the Capsule, opened) and Settings (the avatar).
enum Sheet: String, Identifiable {
    case find, settings, newAgent
    var id: String { rawValue }
}

/// Follows the phone by default (phone.md section 2); Settings offers Dark, Paper and System.
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

    /// The page in front. The app reopens on it, except on Now whenever something needs you.
    var page: Page = .now {
        didSet { UserDefaults.standard.set(page.rawValue, forKey: "page") }
    }
    /// The pushed screens over the pages (a chat, an agent).
    var path: [Dest] = []
    var sheet: Sheet?
    /// The detail sheet over everything (phone.md section 5): a Needs you row, or "Details" on a
    /// chat's approval card.
    var detail: DetailRef?
    /// Where the next pushed session scrolls to, once (Open session).
    var anchor: Anchor?
    /// What the Settings and Find sheets have pushed inside themselves.
    var settingsPath: [Dest] = []
    var findPath: [Dest] = []
    /// Bumped when an agent is made or changed, so the Agents page reads the list again.
    var agentsVersion = 0
    /// A link that could not be followed: its item is gone.
    var gone: String?
    var route: Route?
    var theme: Theme {
        didSet { UserDefaults.standard.set(theme.rawValue, forKey: "theme") }
    }
    /// A reachable box: false after a request failed with `offline`, true after one succeeded.
    var online = true
    /// Vault values are on screen: blur the app when it leaves the front.
    var secretOnScreen = false
    var inFront = true
    /// The owner's name from `system.info`'s `owner.name`, when the box carries it.
    private(set) var ownerName: String?
    /// The assistant's name: `system.info`'s `assistant.name`, else the `agents.list` entry of kind "assistant".
    private(set) var assistantName: String?

    /// Who answers in a transcript when no agent is named: the assistant, never the model.
    var assistantLabel: String { assistantName ?? "Vyre" }

    init() {
        theme = Theme(rawValue: UserDefaults.standard.string(forKey: "theme") ?? "") ?? .system
        page = Page(rawValue: UserDefaults.standard.string(forKey: "page") ?? "") ?? .now
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
            if needs.count > 0 && route == nil && path.isEmpty { page = .now }
            await loadNames()
        }
    }

    /// The owner's and the assistant's names. A box without `owner` or an assistant keeps nil.
    func loadNames() async {
        let info = try? await call("system.info")
        ownerName = info?["owner"]["name"].string.flatMap { $0.isEmpty ? nil : $0 }
        let listed = (try? await call("agents.list"))?.list.first { $0["kind"].string == "assistant" }?["name"].string
        // The label is system.info's assistant.name (null means "Vyre"), else agents.list's assistant.
        assistantName = info?["assistant"]["name"].string ?? listed ?? info?["assistant"].string
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

    /// `callProvingIfAsked` with the offline banner kept up to date.
    func callProvingIfAsked(_ tool: String, _ input: JSON = [:], reason: String) async throws -> JSON {
        guard let client else { throw VyreError.offline("Not signed in.") }
        do {
            let out = try await client.callProvingIfAsked(tool, input, reason: reason)
            online = true
            return out
        } catch let e as VyreError {
            if case .offline = e { online = false }
            throw e
        }
    }

    /// `VyreClient.present` (Face ID only when the box needs it and no session is live) with the
    /// offline banner kept up to date.
    @discardableResult
    func present(_ calls: [SignedCall], reason: String, required: Bool = false) async throws -> [JSON] {
        guard let client else { throw VyreError.offline("Not signed in.") }
        do {
            let out = try await client.present(calls, reason: reason, required: required)
            online = true
            return out
        } catch let e as VyreError {
            if case .offline = e { online = false }
            throw e
        }
    }

    /// Open the session an item came from, at the moment it was raised (phone.md section 5):
    /// the sheet closes first, then Chat pushes the session, which scrolls to the anchor.
    func openSession(_ anchor: Anchor) {
        guard let thread = anchor.thread, !thread.isEmpty else { return }
        detail = nil
        sheet = nil
        self.anchor = anchor
        path = [.thread(thread)]
    }

    /// Follow a link: a push's path, `vyre://`, a DEBUG launch argument or a tap inside the app.
    func open(_ route: Route) {
        self.route = route
        follow()
    }

    /// Where the pending route leads. A held item or an ask waits for the needs to load.
    func follow() {
        guard let r = route else { return }
        switch r {
        case .needs(let id):
            sheet = nil
            page = .now
            if let item = needs.item(raw: id) { path = []; detail = DetailRef(id: item.id) }
            else if needs.loaded { path = []; gone = "That item is no longer waiting. It was answered somewhere else." }
            else { return }
        case .thread(let id):
            sheet = nil
            path = [.thread(id)]
        case .settings:
            settingsPath = []
            sheet = .settings
        case .vault:
            settingsPath = [.vault]
            sheet = .settings
        case .memory:
            findPath = [.memory(nil)]
            sheet = .find
        }
        route = nil
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
/// `-VyrePage now|chats|agents`, `-VyreSheet find|settings`, `-VyreTheme dark|paper|system`,
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
