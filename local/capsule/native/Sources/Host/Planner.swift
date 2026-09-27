// Planner: the box's alarms, timers and reminders ringing on this Mac (ADR 0025, planner team).
//
// The box emits planner.fired when something falls due and planner.acked when someone deals with
// it anywhere; the Mac's vyred passes the box's events on at /v1/link/events. The Capsule keeps
// that one stream open, hidden or not (it is why a timer rings at all), and shows one banner per
// firing, top right, with Done and Snooze. A later ring of the same firing replaces its banner; an
// ack from another device takes it away. Nothing polls: the stream is pushed, and when it drops the
// Capsule waits and opens it again, backing off to a minute.

import Foundation
import UserNotifications

/// One firing, as planner.fired and planner.ringing shape it.
public struct PlannerFiring: Sendable, Equatable {
    public var firing: String
    public var kind: String
    public var title: String
    public var missed: Bool
    public var ring: Int

    public init?(_ p: [String: Any]) {
        guard let f = VJ.nonEmpty(p["firing"]) else { return nil }
        firing = f; kind = VJ.s(p["kind"]); title = VJ.s(p["title"]); missed = VJ.truthy(p["missed"]); ring = VJ.int(p["ring"]) ?? 1
    }

    /// The banner's words: "Missed: Timer" when it fell due while things were offline.
    public var heading: String {
        let what = ["alarm": "Alarm", "timer": "Timer", "reminder": "Reminder", "event": "Event", "todo": "To do"][kind] ?? "Reminder"
        return missed ? "Missed: \(what)" : what
    }
    public var body: String { title.isEmpty ? heading : title }
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
        open()
    }

    func stop() { stopped = true; conn?.stop(); conn = nil }

    private func open() {
        guard !stopped else { return }
        let c = SSEConnection(socket: vyred.socket, path: "/v1/link/events?type=planner.*&since=latest",
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
        // What is already ringing, for a Mac that connects late.
        Task { @MainActor in
            let r = await self.call("planner.ringing", [:])
            for x in (r.data as? [[String: Any]]) ?? [] { if let f = PlannerFiring(x) { self.ring(f) } }
        }
    }

    private func ended() {
        conn = nil
        guard !stopped else { return }
        let w = wait
        wait = min(wait * 2, 60)
        DispatchQueue.main.asyncAfter(deadline: .now() + w) { [weak self] in self?.open() }
    }

    func event(_ e: VyredEvent) {
        switch e.type {
        case "planner.fired": if let f = PlannerFiring(e.payload) { ring(f) }
        case "planner.acked": if let id = VJ.nonEmpty(e.payload["firing"]) { unring(id) }
        default: break
        }
    }

    func ring(_ f: PlannerFiring) {
        if let show { show(f); return }
        let c = UNMutableNotificationContent()
        c.title = f.heading
        c.body = f.body
        c.categoryIdentifier = Self.category
        c.threadIdentifier = "vyre.planner"
        c.sound = f.missed ? nil : .default
        c.interruptionLevel = f.kind == "alarm" || f.kind == "timer" ? .timeSensitive : .active
        c.userInfo = ["firing": f.firing]
        let center = UNUserNotificationCenter.current()
        // The same identifier replaces the banner a later ring of this firing left.
        center.getNotificationSettings { s in
            if s.authorizationStatus == .notDetermined {
                center.requestAuthorization(options: [.alert, .sound]) { ok, _ in
                    if ok { center.add(UNNotificationRequest(identifier: f.firing, content: c, trigger: nil)) }
                }
            } else {
                center.add(UNNotificationRequest(identifier: f.firing, content: c, trigger: nil))
            }
        }
    }

    func unring(_ firing: String) {
        if let drop { drop(firing); return }
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [firing])
    }

    /// A planner tool: through local vyred, which forwards to the box when paired; through
    /// link.call when this vyred does not carry the planner itself.
    func call(_ tool: String, _ input: [String: Any]) async -> VyredResult {
        if vyred.has(tool) { return await vyred.call(tool, input, presence: false) }
        let r = await vyred.call("link.call", ["tool": tool, "input": input], presence: false)
        if let d = r.data as? [String: Any], d["result"] == nil { return .success(d) }
        return r
    }

    /// Done or Snooze on a banner.
    func act(_ action: String, firing: String) async -> String? {
        let tool = action == "snooze" ? "planner.snooze" : "planner.done"
        let r = await call(tool, ["firing": firing])
        return Bridge.explain(r)
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler done: @escaping () -> Void) {
        let firing = response.notification.request.content.userInfo["firing"] as? String
        let action = response.actionIdentifier
        guard let firing, action == "done" || action == "snooze" else { done(); return }
        Task { @MainActor in
            _ = await self.act(action, firing: firing)
            done()
        }
    }

    /// Banners show even while the Capsule is the app in front.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                            withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        done([.banner, .sound, .list])
    }
}
