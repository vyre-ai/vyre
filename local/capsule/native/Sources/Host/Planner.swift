// Planner: the box's alarms, timers and reminders ringing on this Mac (ADR 0025, planner team).
//
// The box emits planner.fired when something falls due and planner.acked when someone deals with
// it anywhere; the Mac's vyred passes the box's events on at /v1/link/events. The Capsule keeps
// that one stream open, hidden or not (it is why a timer rings at all), and shows one banner per
// firing, top right, with Done and Snooze. A later ring of the same firing replaces its banner; an
// ack from another device takes it away. Nothing polls: the stream is pushed, and when it drops the
// Capsule waits and opens it again, backing off to a minute.
//
// Every ring carries a key, "planner-<item>-<due in epoch seconds>", and the key is the
// notification's identifier. The Capsule also schedules the next 48 hours of rings locally
// (planner.upcoming, ADR 0029 R6) under the same keys, so a timer rings with the box unreachable,
// and the box's ring and the local one show once. The schedule is read again on any planner event
// but a firing, and on wake. An answer given while the box was unreachable is sent by key later.

import AppKit
import Foundation
import UserNotifications

/// One firing, as planner.fired and planner.ringing shape it.
public struct PlannerFiring: Sendable, Equatable {
    public var firing: String
    public var key: String?
    public var kind: String
    public var title: String
    public var missed: Bool
    public var ring: Int

    public init?(_ p: [String: Any]) {
        guard let f = VJ.nonEmpty(p["firing"]) else { return nil }
        firing = f; key = VJ.nonEmpty(p["key"]); kind = VJ.s(p["kind"]); title = VJ.s(p["title"]); missed = VJ.truthy(p["missed"]); ring = VJ.int(p["ring"]) ?? 1
    }

    /// The notification's identifier: the key, so a local ring of the same moment is replaced.
    public var id: String { key ?? firing }

    /// The banner's words: "Missed: Timer" when it fell due while things were offline.
    public var heading: String {
        let what = ["alarm": "Alarm", "timer": "Timer", "reminder": "Reminder", "event": "Event", "todo": "To do"][kind] ?? "Reminder"
        return missed ? "Missed: \(what)" : what
    }
    public var body: String { title.isEmpty ? heading : title }
}

/// One ring to come, as planner.upcoming lists it: scheduled here under its key.
public struct PlannerEntry: Sendable, Equatable {
    public var key: String
    public var kind: String
    public var title: String
    /// When it rings, in ms.
    public var at: Double
    public var loud: Bool

    public init?(_ p: [String: Any]) {
        guard let k = VJ.nonEmpty(p["key"]), let at = VJ.num(p["at"]) ?? VJ.num(p["due"]).map({ $0 * 1000 }) else { return nil }
        key = k; kind = VJ.s(p["kind"]); title = VJ.s(p["title"]); self.at = at; loud = VJ.truthy(p["loud"])
    }

    var firing: PlannerFiring { PlannerFiring(["firing": key, "key": key, "kind": kind, "title": title])! }
}

@MainActor
final class PlannerBanners: NSObject, UNUserNotificationCenterDelegate {
    static let category = "vyre.planner"
    let vyred: VyredClient
    private var conn: SSEConnection?
    private var wait: TimeInterval = 3
    private var stopped = false
    /// For tests: where banners go instead of the Notification Center.
    var show: ((PlannerFiring) -> Void)?
    var drop: ((String) -> Void)?
    /// For tests: the local schedule instead of pending notifications (every key, replaced whole).
    var scheduled: (([PlannerEntry]) -> Void)?
    var now: () -> Double = { Date().timeIntervalSince1970 * 1000 }
    /// Keys this Capsule scheduled, so a refresh removes the ones the box no longer lists.
    private(set) var pendingKeys: Set<String> = []
    /// Answers to local rings the box has not taken yet: (action, key), sent again on reconnect.
    private(set) var unsent: [(action: String, key: String)] = []
    private var refreshing = false

    init(vyred: VyredClient) { self.vyred = vyred }

    func start() {
        guard dialogsAllowed() || show != nil else { return }
        if show == nil {
            let c = UNUserNotificationCenter.current()
            c.delegate = self
            let done = UNNotificationAction(identifier: "done", title: "Done", options: [])
            let snooze = UNNotificationAction(identifier: "snooze", title: "Snooze 9 min", options: [])
            c.setNotificationCategories([UNNotificationCategory(identifier: Self.category, actions: [done, snooze], intentIdentifiers: [])])
        }
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in await self?.refresh() }
        }
        Task { @MainActor in await self.connect() }
    }

    func stop() { stopped = true; conn?.stop(); conn = nil }

    /// What rings now, then the stream from that cursor, so nothing between the two is lost.
    private func connect() async {
        guard !stopped else { return }
        let r = await call("planner.ringing", ["cursor": true])
        open(since: absorbRinging(r.data))
    }

    /// Ring what planner.ringing lists; the cursor to follow events from ("latest" without one).
    func absorbRinging(_ data: Any?) -> String {
        if let d = data as? [String: Any] {
            for x in (d["ringing"] as? [[String: Any]]) ?? [] { if let f = PlannerFiring(x) { ring(f) } }
            return VJ.int(d["last_event"]).map(String.init) ?? "latest"
        }
        // An older planner answers with the list alone.
        for x in (data as? [[String: Any]]) ?? [] { if let f = PlannerFiring(x) { ring(f) } }
        return "latest"
    }

    private func open(since: String) {
        guard !stopped else { return }
        let c = SSEConnection(socket: vyred.socket, path: "/v1/link/events?type=planner.*&since=\(since)",
            onOpen: { [weak self] in Task { @MainActor in self?.opened() } },
            onEvent: { [weak self] json in
                guard let e = VyredEvent(json: json) else { return }
                Task { @MainActor in self?.event(e) }
            },
            onEnd: { [weak self] in Task { @MainActor in self?.ended() } })
        conn = c
        c.start()
    }

    private func opened() {
        wait = 3
        Task { @MainActor in
            await self.flush()
            await self.refresh()
        }
    }

    private func ended() {
        conn = nil
        guard !stopped else { return }
        let w = wait
        wait = min(wait * 2, 60)
        DispatchQueue.main.asyncAfter(deadline: .now() + w) { [weak self] in Task { @MainActor in await self?.connect() } }
    }

    func event(_ e: VyredEvent) {
        switch e.type {
        case "planner.fired": if let f = PlannerFiring(e.payload) { ring(f) }
        case "planner.acked":
            if let k = VJ.nonEmpty(e.payload["key"]) { unring(k); pendingKeys.remove(k) }
            if let id = VJ.nonEmpty(e.payload["firing"]) { unring(id) }
            Task { @MainActor in await self.refresh() }
        default:
            // An add, a change, a snooze or planner.schedule (zone, lead time, a calendar sync).
            if e.type.hasPrefix("planner.") { Task { @MainActor in await self.refresh() } }
        }
    }

    /// Schedule the next 48 hours of rings here, each under its key. Keys the box no longer
    /// lists are removed. Nothing happens on a planner without planner.upcoming.
    func refresh() async {
        guard !refreshing else { return }
        refreshing = true
        defer { refreshing = false }
        let r = await call("planner.upcoming", ["hours": 48])
        guard let d = r.data as? [String: Any], let rows = d["entries"] as? [[String: Any]] else { return }
        let t = now()
        let entries = rows.compactMap(PlannerEntry.init).filter { $0.at > t }
        let keys = Set(entries.map(\.key))
        let gone = pendingKeys.subtracting(keys)
        pendingKeys = keys
        if let scheduled { scheduled(entries); return }
        let center = UNUserNotificationCenter.current()
        if !gone.isEmpty { center.removePendingNotificationRequests(withIdentifiers: Array(gone)) }
        for e in entries {
            let c = content(e.firing)
            if !e.loud { c.interruptionLevel = .active }
            // At the wall moment, not an interval from now: a clock correction or a long gap
            // before the next refresh cannot skew it. `at` is an absolute instant.
            let when = Calendar.current.dateComponents(in: .current, from: Date(timeIntervalSince1970: e.at / 1000))
            var parts = DateComponents(year: when.year, month: when.month, day: when.day, hour: when.hour, minute: when.minute, second: when.second)
            parts.timeZone = .current
            let req = UNNotificationRequest(identifier: e.key, content: c, trigger: UNCalendarNotificationTrigger(dateMatching: parts, repeats: false))
            center.add(req, withCompletionHandler: nil)
        }
    }

    private func content(_ f: PlannerFiring) -> UNMutableNotificationContent {
        let c = UNMutableNotificationContent()
        c.title = f.heading
        c.body = f.body
        c.categoryIdentifier = Self.category
        c.threadIdentifier = "vyre.planner"
        c.sound = f.missed ? nil : .default
        c.interruptionLevel = f.kind == "alarm" || f.kind == "timer" ? .timeSensitive : .active
        var info: [String: String] = ["firing": f.firing]
        if let k = f.key { info["key"] = k }
        c.userInfo = info
        return c
    }

    func ring(_ f: PlannerFiring) {
        if let show { show(f); return }
        let c = content(f)
        let center = UNUserNotificationCenter.current()
        // The same identifier (the key) replaces the banner a later ring, or the local ring of the
        // same moment, left; a pending local ring for it is dropped.
        center.removePendingNotificationRequests(withIdentifiers: [f.id])
        center.getNotificationSettings { s in
            if s.authorizationStatus == .notDetermined {
                center.requestAuthorization(options: [.alert, .sound]) { ok, _ in
                    if ok { center.add(UNNotificationRequest(identifier: f.id, content: c, trigger: nil)) }
                }
            } else {
                center.add(UNNotificationRequest(identifier: f.id, content: c, trigger: nil))
            }
        }
    }

    func unring(_ id: String) {
        if let drop { drop(id); return }
        let center = UNUserNotificationCenter.current()
        center.removeDeliveredNotifications(withIdentifiers: [id])
        center.removePendingNotificationRequests(withIdentifiers: [id])
    }

    /// A planner tool: through local vyred, which forwards to the box when paired; through
    /// link.call when this vyred does not carry the planner itself.
    func call(_ tool: String, _ input: [String: Any]) async -> VyredResult {
        if vyred.has(tool) { return await vyred.call(tool, input, presence: false) }
        let r = await vyred.call("link.call", ["tool": tool, "input": input], presence: false)
        if let d = r.data as? [String: Any], d["result"] == nil { return .success(d) }
        return r
    }

    /// Done or Snooze on a banner: by key when the ring has one (a local ring has only its key).
    /// If the box cannot be reached, the answer is kept and sent by key once it can.
    func act(_ action: String, firing: String, key: String? = nil) async -> String? {
        let tool = action == "snooze" ? "planner.snooze" : "planner.done"
        var input: [String: Any] = key.map { ["key": $0] } ?? ["firing": firing]
        if action == "snooze" { input["minutes"] = 9 }
        let r = await call(tool, input)
        if let key, Self.unreachable(r) { unsent.append((action, key)); return nil }
        return Bridge.explain(r)
    }

    /// Send the answers the box missed, oldest first; the box records each and never rings it.
    func flush() async {
        let queued = unsent
        unsent = []
        for a in queued { _ = await act(a.action, firing: a.key, key: a.key) }
    }

    static func unreachable(_ r: VyredResult) -> Bool {
        guard let c = r.errorCode else { return false }
        return ["unreachable", "timeout", "box_unreachable"].contains(c)
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler done: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        let firing = info["firing"] as? String, key = info["key"] as? String
        let action = response.actionIdentifier
        guard let firing, action == "done" || action == "snooze" else { done(); return }
        Task { @MainActor in
            _ = await self.act(action, firing: firing, key: key)
            done()
        }
    }

    /// Banners show even while the Capsule is the app in front.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                            withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        done([.banner, .sound, .list])
    }
}
