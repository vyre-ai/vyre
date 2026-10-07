// MenuBar: the mark in the menu bar, its health dot, and the popover a click opens.
//
// The dot says how Vyre is reached, with nothing polled: vyred up or down comes from the follower
// the Capsule already runs (it backs off to a minute while hidden), and the box's link from
// link.health, asked at most once a minute and only when the popover or the Capsule opens.
//   signal  vyred up (and the box, if paired, direct)
//   recall  the box is reached through a relay (slower, still working)
//   ash     vyred is not running
// Attention (violet) is not used here: it means "needs you", which is the waiting list's (capsule-now).

import AppKit
import SwiftUI

/// How this Mac reaches its box, in words (bridge.js linkLine, deck/js/health.js).
struct LinkLine: Equatable {
    enum Dot: Equatable { case direct, relayed, unknown }
    var path: String
    var handshake: String?
    var dot: Dot

    static func from(_ x: [String: Any], now: Double = vyNowMs()) -> LinkLine? {
        // wink.server.health: { state: connected | relayed | offline, path, latencyMs, since, why? }
        if let state = VJ.str(x["state"]) {
            let ms = VJ.num(x["latencyMs"]).map { " \(Int($0)) ms" } ?? ""
            let since = VJ.num(x["since"]).map { Route.age($0, now: now) }.map { $0 == "now" ? "since just now" : "since \($0) ago" }
            switch state {
            case "connected": return LinkLine(path: "direct\(ms)", handshake: since, dot: .direct)
            case "relayed": return LinkLine(path: "relayed\(ms)", handshake: since, dot: .relayed)
            default: return LinkLine(path: "offline", handshake: VJ.nonEmpty(x["why"]) ?? since, dot: .unknown)
            }
        }
        guard let p = VJ.str(x["path"]), !p.isEmpty else { return nil }
        let ms = VJ.num(x["latencyMs"]).map { " \(Int($0)) ms" } ?? ""
        let relay = VJ.nonEmpty(x["relay"])
        let path: String
        switch p {
        case "direct": path = "direct\(ms)"
        case "relay": path = "relayed\(relay.map { " via \($0)" } ?? "")\(ms)"
        case "peer-relay": path = "peer relay\(ms)"
        default: path = VJ.str(x["why"]) == "the node is offline" ? "offline" : "unknown"
        }
        let hs = VJ.num(x["lastHandshake"]).map { Route.age($0, now: now) }
        let handshake = hs.map { $0 == "now" ? "last handshake just now" : "last handshake \($0) ago" }
        let dot: Dot = p == "direct" ? .direct : (p == "relay" || p == "peer-relay") ? .relayed : .unknown
        return LinkLine(path: path, handshake: handshake, dot: dot)
    }
}

@MainActor
final class Health: ObservableObject {
    @Published private(set) var vyredUp = false
    @Published private(set) var link: LinkLine?
    /// Why there is no link line ("this Mac is not paired with a box"), when link.health said.
    @Published private(set) var linkWhy: String?
    private var askedAt = 0.0
    private let vyred: VyredClient
    var changed: (() -> Void)?

    init(vyred: VyredClient) { self.vyred = vyred }

    func set(up: Bool) {
        guard up != vyredUp else { return }
        vyredUp = up
        if !up { link = nil }
        changed?()
    }

    /// Ask wink.server.health (link.health on an older vyred) if a minute has passed since the last ask. Called on open only.
    func refresh() {
        let tool = vyred.has(WinkServer.health) ? WinkServer.health : "link.health"
        guard vyredUp, vyred.has(tool), vyNowMs() - askedAt > 60_000 else { return }
        askedAt = vyNowMs()
        Task { @MainActor [vyred] in
            let r = await vyred.call(tool, [:], presence: false)
            let d = (r.data as? [String: Any]) ?? [:]
            let line = LinkLine.from(d)
            // "unknown" with a reason is no box at all: say the reason, draw no link line. (An offline paired server, wink.server.health's "offline", keeps its line.)
            if line?.dot == .unknown, d["state"] == nil, let why = VJ.nonEmpty(d["why"]) { self.link = nil; self.linkWhy = why } else { self.link = line; self.linkWhy = nil }
            self.changed?()
        }
    }

    var dotColor: NSColor {
        if !vyredUp { return IconCache.color(.ash) }
        if link?.dot == .relayed { return IconCache.color(.recall) }
        return IconCache.color(.signal)
    }

    var summary: String {
        if !vyredUp { return "Vyre is not running" }
        if let l = link { return "Server \(l.path)" }
        return "Vyre is running"
    }
}

/// The status item: the mark as a template image (the menu bar tints it) and a small dot in the
/// corner in the token colour for the health above.
@MainActor
final class MenuBarItem: NSObject, NSPopoverDelegate {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    private let dot = NSView(frame: NSRect(x: 0, y: 0, width: 6, height: 6))
    private let popover = NSPopover()
    let health: Health
    var content: () -> AnyView = { AnyView(EmptyView()) }
    /// Right-click: the plain menu, for when the popover is not what is wanted.
    var menu: () -> NSMenu = { NSMenu() }

    init(health: Health) {
        self.health = health
        super.init()
        item.button?.image = CapsuleApp.menuBarMark()
        item.button?.toolTip = "Vyre Lumen"
        item.button?.target = self
        item.button?.action = #selector(clicked(_:))
        item.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])
        dot.wantsLayer = true
        dot.layer?.cornerRadius = 3
        dot.layer?.borderWidth = 1
        dot.layer?.borderColor = NSColor.black.withAlphaComponent(0.35).cgColor
        if let b = item.button {
            b.addSubview(dot)
            dot.frame.origin = NSPoint(x: b.bounds.width - 9, y: 3)
            dot.autoresizingMask = [.minXMargin, .maxYMargin]
        }
        popover.behavior = .transient
        popover.animates = true
        popover.delegate = self
        popover.appearance = NSAppearance(named: .darkAqua)
        health.changed = { [weak self] in self?.paint() }
        paint()
    }

    func paint() {
        dot.layer?.backgroundColor = health.dotColor.cgColor
        item.button?.toolTip = "Vyre Lumen · \(health.summary)"
    }

    @objc private func clicked(_ sender: NSStatusBarButton) {
        if NSApp.currentEvent?.type == .rightMouseUp {
            item.menu = menu()
            item.button?.performClick(nil)
            item.menu = nil
            return
        }
        if popover.isShown { popover.performClose(nil); return }
        health.refresh()
        popover.contentViewController = NSHostingController(rootView: content())
        popover.show(relativeTo: sender.bounds, of: sender, preferredEdge: .minY)
    }

    func close() { if popover.isShown { popover.performClose(nil) } }

    /// Show the popover (⌘, in the Capsule: its settings live here).
    func open() {
        guard let b = item.button, !popover.isShown else { return }
        health.refresh()
        popover.contentViewController = NSHostingController(rootView: content())
        popover.show(relativeTo: b.bounds, of: b, preferredEdge: .minY)
    }
}

/// What the popover shows: whose Vyre this is, who is up, how the box is reached, and the few
/// things to do.
struct MenuBarPopover: View {
    @ObservedObject var health: Health
    /// The person (system.info), for the account row. Empty before the first read: the circle
    /// then draws its no-fingerprint look and the row says "You".
    var identities = Identities()
    let hotkeys: String
    let canTurnOnControl: Bool
    let open: () -> Void
    let turnOnControl: () -> Void
    /// vyred is down: start it from here (the Capsule opens to show it going).
    var start: (() -> Void)? = nil
    /// "Set up Vyre on this Mac" the first time, "Start Vyre" after (CapsuleModel.startWords).
    var startWords: () -> String = { "Start Vyre" }
    let quit: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                LumenMark(size: 20)
                Text("Vyre Lumen").font(Theme.type(Tokens.TypeScale.read, .semibold)).foregroundColor(Theme.bone)
                Spacer()
                Circle().fill(Color(nsColor: health.dotColor)).frame(width: 7, height: 7)
            }
            .padding(.horizontal, 14).padding(.top, 14).padding(.bottom, 10)
            // The account: the person's circle (no Vyre code ring at this size) and their name.
            HStack(spacing: 10) {
                AvatarView(identities.person, size: 24)
                Text(identities.ownerName ?? "You").font(Theme.title).foregroundColor(Theme.bone).lineLimit(1)
                Spacer()
            }
            .padding(.horizontal, 14).padding(.bottom, 10)
            VStack(alignment: .leading, spacing: 6) {
                status(health.vyredUp ? "Vyre is running" : "Vyre is not running", ok: health.vyredUp,
                       sub: health.vyredUp ? nil : "\(startWords()) below, or press Return in Lumen")
                if let l = health.link {
                    status("Server \(l.path)", ok: l.dot == .direct, sub: l.handshake)
                } else if let why = health.linkWhy {
                    status("No server", ok: true, sub: why, quiet: true)
                }
            }
            .padding(.horizontal, 14).padding(.bottom, 12)
            Rule()
            VStack(spacing: 2) {
                if !health.vyredUp, let start { PopoverButton(title: startWords(), hint: nil, action: start) }
                PopoverButton(title: "Open Lumen", hint: hotkeys, action: open)
                if canTurnOnControl { PopoverButton(title: "Turn on Control twice…", hint: nil, action: turnOnControl) }
            }
            .padding(6)
            Rule()
            PopoverButton(title: "Quit Lumen", hint: "⌘Q", action: quit).padding(6)
        }
        .frame(width: 280)
        .background(Theme.carbon)
    }

    private func status(_ title: String, ok: Bool, sub: String?, quiet: Bool = false) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Circle().fill(quiet ? Theme.ash : ok ? Theme.signal : Theme.ash).frame(width: 6, height: 6)
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(Theme.title).foregroundColor(Theme.bone)
                if let sub { Text(sub).font(Theme.subtitle).foregroundColor(Theme.ash) }
            }
        }
    }
}

struct PopoverButton: View {
    let title: String
    let hint: String?
    let action: () -> Void
    @State private var hover = false
    var body: some View {
        Button(action: action) {
            HStack {
                Text(title).font(Theme.title).foregroundColor(Theme.bone)
                Spacer()
                if let hint { Text(hint).font(Theme.subtitle).foregroundColor(Theme.ash) }
            }
            .padding(.horizontal, 8).frame(height: 28)
            .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(hover ? Theme.raised : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
    }
}
