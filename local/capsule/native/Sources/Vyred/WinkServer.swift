// WinkServer: how this Mac asks the server it is paired to. Wink owns the pairing (the typed code, the signed identity list); the Mac's vyred answers two tools for it, and this file is the one place
// that names them, so the callers (BoxLink, the Planner, history import) do not.
//
//   wink.server.home   {}                      -> { linked: Bool, reachable?: Bool, name?: String, box?: { name?, address? } }   (core/cli/commands/up.js reads `linked`)
//   wink.server.call   { tool, input, device? } -> the server tool's own answer, or { error: { code, message } }
//
// What the contract does not say yet (assumed here, one line sent to network): the address and name sit under `box` as link.status had them, `reachable` may be absent (read as true when linked),
// an unreachable server answers with an error code in `unreachableCodes`, and the server's events still arrive on /v1/link/events. There is no health tool, no sleep tool and no wake tool: the menu bar's
// link line and the sleep and wake hellos stay behind `has(...)` and say nothing until one exists.

import Foundation

public enum WinkServer {
    public static let home = "wink.server.home"
    public static let call = "wink.server.call"
    /// The server's thread, ask and memory events, proxied by this Mac's vyred (assumed unchanged).
    public static let eventsPath = "/v1/link/events"
    /// Error codes that mean the server is not there (as opposed to slow or refusing).
    public static let unreachableCodes: Set<String> = ["box_unreachable", "server_unreachable", "no_link", "unpaired"]

    public struct Home: Sendable, Equatable {
        public var linked: Bool
        public var reachable: Bool?
        public var name: String?
        public var address: String?
    }

    /// `wink.server.home`'s answer, or nil when it is not an object.
    public static func parseHome(_ data: Any?) -> Home? {
        guard let o = data as? [String: Any] else { return nil }
        let box = o["box"] as? [String: Any]
        let linked = VJ.truthy(o["linked"])
        return Home(linked: linked, reachable: linked ? (o["reachable"] as? Bool ?? true) : nil,
                    name: VJ.nonEmpty(box?["name"]) ?? VJ.nonEmpty(o["name"]), address: Glass.origin(VJ.str(box?["address"] ?? o["address"])))
    }

    /// The input of `wink.server.call` for one server tool.
    public static func callInput(_ tool: String, _ input: [String: Any]) -> [String: Any] { ["tool": tool, "input": input] }
}
