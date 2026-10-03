// ContextReport: where in the world this Mac is, told to vyred (context.report), so the Planner reads "6pm" in the person's own zone (#58).
//
// Only the IANA zone name goes (America/Los_Angeles): no place, no address, no clock reading. It is sent when this vyred is found,
// when the Capsule shows, and when the Mac's zone changes. Nothing is sent when this vyred has no context.report.

import Foundation

extension CapsuleModel {
    /// The Mac's IANA zone name, or nil when the system gives no usable one.
    nonisolated static func zoneName(_ zone: TimeZone = .current) -> String? {
        let id = zone.identifier
        return id.isEmpty ? nil : id
    }

    /// Tell vyred the zone. Quiet on any failure: the Planner then reads the zone it already knows.
    func reportZone() {
        guard vyred.isUp, vyred.has("context.report"), let tz = Self.zoneName() else { return }
        let device = Host.current().localizedName ?? "this Mac"
        Task { [vyred] in _ = await vyred.call("context.report", ["surface": "capsule", "device": String(device.prefix(80)), "tz": tz], presence: false) }
    }
}
