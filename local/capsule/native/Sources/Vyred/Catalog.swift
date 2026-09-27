// Catalog: what `@` can name (agents, projects, threads), read from vyred when the Capsule shows.
// Ported from bridge.js refresh(). Read once per show while vyred is up, never on a timer.

import Foundation

public enum CatalogLoader {
    public static func load(_ v: VyredLink) async -> VyreCatalog {
        async let agentsR = v.has("agents.list") ? v.call("agents.list", [:], presence: false) : nil
        async let projectsR = v.call("projects.list", [:], presence: false)
        async let recentR = v.call("projects.catalog", ["limit": 30, "human": true], presence: false)
        async let headlessR = v.has("threads.list") ? v.call("threads.list", [:], presence: false) : nil
        let (agents, projects, recent, headless) = await (agentsR, projectsR, recentR, headlessR)
        let list = ((projects.data as? [String: Any])?["projects"] as? [[String: Any]]) ?? []
        func nameOf(_ slug: String) -> String { list.first { VJ.s($0["slug"]) == slug }.flatMap { VJ.nonEmpty($0["name"]) } ?? slug }
        var threads: [VyreThread] = []
        var seen = Set<String>()
        var per: [[[String: Any]]] = []
        for p in list {
            let r = await v.call("projects.threads", ["project": VJ.s(p["slug"]), "limit": 20], presence: false)
            per.append((r.data as? [[String: Any]]) ?? [])
        }
        func label(_ x: [String: Any]) -> String {
            VJ.nonEmpty(x["label"]) ?? VJ.nonEmpty(x["name"]) ?? VJ.nonEmpty(x["title"]) ?? String(VJ.s(x["id"]).prefix(8))
        }
        for (i, p) in list.enumerated() {
            for x in per[i] where seen.insert(VJ.s(x["id"])).inserted {
                threads.append(VyreThread(id: VJ.s(x["id"]), label: label(x), cwd: VJ.str(x["cwd"]), last: VJ.num(x["last"]),
                                          project: VJ.s(p["slug"]), projectName: VJ.str(p["name"])))
            }
        }
        for x in (headless?.data as? [[String: Any]]) ?? [] where seen.insert(VJ.s(x["id"])).inserted {
            let proj = VJ.nonEmpty(x["project"])
            threads.append(VyreThread(id: VJ.s(x["id"]), label: VJ.nonEmpty(x["name"]) ?? VJ.str(x["cwd"]).flatMap { $0.split(separator: "/").last.map(String.init) } ?? String(VJ.s(x["id"]).prefix(8)),
                                      cwd: VJ.str(x["cwd"]), last: VJ.num(x["last"]), project: proj, projectName: proj.map(nameOf), agent: VJ.nonEmpty(x["agent"])))
        }
        for x in ((recent.data as? [String: Any])?["sessions"] as? [[String: Any]]) ?? [] where seen.insert(VJ.s(x["id"])).inserted {
            threads.append(VyreThread(id: VJ.s(x["id"]), label: label(x), cwd: VJ.str(x["cwd"]), last: VJ.num(x["last"])))
        }
        var agentRows: [[String: Any]]?
        if let d = agents?.data { agentRows = (d as? [[String: Any]]) ?? ((d as? [String: Any])?["agents"] as? [[String: Any]]) ?? [] }
        return VyreCatalog(
            agents: agentRows?.map { a in VyreAgent(name: VJ.s(a["name"]), kind: VJ.str(a["kind"]), doing: VJ.nonEmpty(a["doing"]) ?? VJ.nonEmpty(a["status"]),
                                                    thread: VJ.nonEmpty(a["thread"]), computer: VJ.truthy(a["computer"])) },
            projects: list.map { p in VyreProject(slug: VJ.s(p["slug"]), name: VJ.nonEmpty(p["name"]) ?? VJ.s(p["slug"]), org: VJ.str(p["org"]), home: VJ.str(p["home"]),
                                                  threads: VJ.int(p["threads"]), last: VJ.num(p["last"]),
                                                  // The people in a project make a question about them the user's own (Route.ownThings).
                                                  people: ((p["people"] as? [[String: Any]]) ?? []).compactMap { x in VJ.nonEmpty(x["name"]).map { VyrePerson(name: $0, email: VJ.nonEmpty(x["email"])) } }) },
            threads: threads)
    }
}
