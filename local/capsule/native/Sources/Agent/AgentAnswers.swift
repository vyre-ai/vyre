// Whether vyred is known to be down, for the offline line (UI/AgentDeskView.swift OfflineBanner).
// (Enter on a sum copying it is capsule-pro's, in Host/CopyRows.swift.)

import AppKit

extension CapsuleModel {
    /// vyred was looked for and is not there: say so, once, above what still works on this Mac.
    var offline: Bool { !vyred.isUp && vyred.follower.isWaiting }
}
