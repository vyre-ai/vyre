// MountConfig: the names the app and the Finder extension must agree on (the Mac half of Vyre in Finder).

import Foundation

public enum MountConfig {
    /// The app group both share. A signed build with a team uses "<TEAMID>.group.sh.vyre.files"; the one place to change is here.
    public static let group = "group.sh.vyre.files"
    /// The File Provider domain: what Finder lists as "Vyre" in the sidebar.
    public static let domainId = "sh.vyre.files"
    public static let displayName = "Vyre"
    public static let appexBundleId = "sh.vyre.capsule.files"
    /// The socket the app listens on and the extension calls, inside the group's folder. A unix socket path holds at most 103 bytes, so the file name is short.
    public static let socketName = "m.sock"

    /// The socket's full path under a group folder, or nil when it would not fit.
    public static func socketPath(inGroupFolder folder: String) -> String? {
        let p = (folder as NSString).appendingPathComponent(socketName)
        return p.utf8.count <= 103 ? p : nil
    }
}
