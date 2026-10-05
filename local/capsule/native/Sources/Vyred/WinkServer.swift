// WinkServer: how this Mac asks the server it is paired to. Wink owns the pairing (the typed code, the signed identity list); the Mac's vyred answers two tools for it, and this file is the one place
// that names them, so the callers (BoxLink, the Planner, history import) do not.
//
//   wink.server.home   {}                      -> { linked: Bool, reachable?: Bool, name?: String, box?: { name?, address? } }   (core/cli/commands/up.js reads `linked`)
//   wink.server.call   { tool, input, device? } -> the server tool's own answer, or { error: { code, message } }
//
// What the contract does not say yet (assumed here, one line sent to network): the address and name sit under `box` as link.status had them, `reachable` may be absent (read as true when linked),
// an unreachable server answers with an error code in `unreachableCodes`, and the server's events arrive on /v1/wink/server-events (SSE: id, event name = type, data = the event plus source "box"; link.down and link.up when the server goes away or
// comes back). Final shapes from network-2 (work/network2-srv 91723e204): home is { linked, reachable, box: { device, name, address }, lastSeen, via }, health is { state: connected | relayed |
// offline, path, latencyMs, since, why? }. There is no sleep tool or wake tool yet: the Mac's hellos stay behind `has(...)` and say nothing until one exists.

import Foundation

public enum WinkServer {
    public static let home = "wink.server.home"
    public static let call = "wink.server.call"
    /// The link line for the menu bar: { state, path, latencyMs, since, why? }. Cached 15 s on the server.
    public static let health = "wink.server.health"
    /// The server's thread, ask and memory events, proxied by this Mac's vyred (assumed unchanged).
    public static let eventsPath = "/v1/wink/server-events"
    /// Events about the link itself, not a thread: the server went away, or came back.
    public static let linkDown = "link.down", linkUp = "link.up"
    /// Error codes that mean the server is not there (as opposed to slow or refusing).
    public static let unreachableCodes: Set<String> = ["box_unreachable", "server_unreachable", "no_link", "unpaired"]

    /// A vyred that does not have the Wink tools yet (an older one, or a trunk that has not merged them) still answers the link.* tools: the same answers, so the Mac keeps working against it.
    public static let legacyHome = "link.status", legacyCall = "link.call", legacyEventsPath = "/v1/link/events"
    public static func homeTool(_ has: (String) -> Bool) -> String { has(home) ? home : legacyHome }
    public static func callTool(_ has: (String) -> Bool) -> String { has(call) ? call : legacyCall }
    /// The events route follows the same choice: the Wink route where the vyred has the Wink tools.
    public static func eventsPath(_ has: (String) -> Bool) -> String { has(home) ? eventsPath : legacyEventsPath }

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
