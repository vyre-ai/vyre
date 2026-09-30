// SpecVectorsTests: loads spec/capsule/{route,commands,match}.json (C2, the golden vectors shared
// with the Windows panel) and asserts this Swift implementation (Route, CLIRun, Match) passes
// every case. This is the side that proves the vectors are true; the Node test at
// test/capsule-spec.test.js only checks their shape. Runs on GitHub Actions only (RULES.md: no
// Swift build or test on the user's Mac).

import Foundation

// MARK: - Loading the spec files

private enum SpecLoad {
    /// The repo root, from this file's own compiled-in path: Tests -> native -> capsule -> local -> root.
    static let repoRoot: URL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent() // Tests
        .deletingLastPathComponent() // native
        .deletingLastPathComponent() // capsule
        .deletingLastPathComponent() // local
        .deletingLastPathComponent() // repo root

    static func json(_ name: String) -> [String: Any] {
        let url = repoRoot.appendingPathComponent("spec/capsule/\(name)")
        guard let data = try? Data(contentsOf: url), let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            fatalError("SpecVectorsTests: could not load \(url.path)")
        }
        return obj
    }
}

private func str(_ v: Any?) -> String? { v as? String }
private func arr(_ v: Any?) -> [Any] { (v as? [Any]) ?? [] }
private func dict(_ v: Any?) -> [String: Any] { (v as? [String: Any]) ?? [:] }
private func num(_ v: Any?) -> Double? {
    if let n = v as? NSNumber { return n.doubleValue }
    return nil
}
private func boolOf(_ v: Any?) -> Bool? { v as? Bool }

// MARK: - route.json: building catalogs and running each fn

/// "now", "now-2h", "now-4day" -> a millisecond timestamp against the fixture's own `now`.
private func fixtureTime(_ s: String, now: Double, day: Double) -> Double {
    if s == "now" { return now }
    guard let dash = s.firstIndex(of: "-") else { return now }
    let rest = s[s.index(after: dash)...]
    if rest.hasSuffix("day") {
        let n = Double(rest.dropLast(3)) ?? 0
        return now - n * day
    }
    if rest.hasSuffix("h") {
        let n = Double(rest.dropLast(1)) ?? 0
        return now - n * 3_600_000
    }
    return now
}

private func buildCatalog(_ j: [String: Any], now: Double, day: Double) -> VyreCatalog {
    func person(_ j: [String: Any]) -> VyrePerson { VyrePerson(name: str(j["name"]) ?? "") }
    func agent(_ j: [String: Any]) -> VyreAgent {
        VyreAgent(name: str(j["name"]) ?? "", kind: str(j["kind"]), doing: str(j["doing"]), thread: str(j["thread"]))
    }
    func project(_ j: [String: Any]) -> VyreProject {
        VyreProject(slug: str(j["slug"]) ?? "", name: str(j["name"]) ?? "", org: str(j["org"]), home: str(j["home"]),
                    threads: num(j["threads"]).map(Int.init), last: (str(j["last"])).map { fixtureTime($0, now: now, day: day) },
                    people: arr(j["people"]).compactMap { $0 as? [String: Any] }.map(person))
    }
    func thread(_ j: [String: Any]) -> VyreThread {
        VyreThread(id: str(j["id"]) ?? "", label: str(j["label"]) ?? "", cwd: str(j["cwd"]),
                   last: (str(j["last"])).map { fixtureTime($0, now: now, day: day) }, project: str(j["project"]),
                   projectName: str(j["projectName"]), agent: str(j["agent"]))
    }
    // agents: absent from JSON (null) means nil; present as [] means an empty switchboard.
    let agentsField = j["agents"]
    let agents: [VyreAgent]?
    if agentsField is NSNull || agentsField == nil { agents = nil } else { agents = arr(agentsField).compactMap { $0 as? [String: Any] }.map(agent) }
    return VyreCatalog(agents: agents, projects: arr(j["projects"]).compactMap { $0 as? [String: Any] }.map(project),
                       threads: arr(j["threads"]).compactMap { $0 as? [String: Any] }.map(thread))
}

private func candidate(_ j: [String: Any]) -> VyreCandidate {
    let kind: CandidateKind
    switch str(j["kind"]) {
    case "agent": kind = .agent
    case "project": kind = .project
    case "thread": kind = .thread
    default: kind = .app
    }
    return VyreCandidate(kind: kind, id: str(j["id"]) ?? "", label: str(j["label"]) ?? str(j["id"]) ?? "")
}

private func kindLabel(_ d: VyreDestination) -> String { "\(d.kind.rawValue):\(d.agent ?? d.model ?? "-")" }

private func checkOptionField(_ t: Suite, _ d: VyreDestination, _ field: String, _ expect: Any, _ where_: String) {
    switch field {
    case "kind": t.eq(d.kind.rawValue, str(expect), where_)
    case "agent": t.eq(d.agent, str(expect), where_)
    case "thread": t.eq(d.thread, str(expect), where_)
    case "meta": t.eq(d.meta, str(expect) ?? "", where_)
    case "cwd": t.eq(d.cwd, str(expect), where_)
    case "deep": t.eq(d.deep, boolOf(expect) ?? false, where_)
    default: break
    }
}

private func runRouteCase(_ t: Suite, _ c: [String: Any], _ world: [String: Any], _ catalogs: [String: Any], _ threadSets: [String: Any]) {
    let input = dict(c["input"])
    let expect = dict(c["expect"])
    let note = str(c["note"]) ?? ""
    let now = num(world["now"]) ?? 0
    let day = num(world["day"]) ?? 86_400_000

    func loadCatalog(_ name: String) -> VyreCatalog { buildCatalog(dict(catalogs[name]), now: now, day: day) }

    switch str(input["fn"]) {
    case "asksQuestion":
        t.eq(Route.asksQuestion(str(input["text"]) ?? ""), boolOf(c["expect"]) ?? false, note)

    case "ownThings":
        let cat = loadCatalog(str(input["catalog"]) ?? "default")
        let got = Route.ownThings(str(input["text"]) ?? "", cat)
        if c["expect"] is NSNull || c["expect"] == nil {
            t.ok(got == nil, "\(note): expected nil, got \(got ?? "?")")
        } else if let contains = str(dict(c["expect"])["contains"]) {
            t.ok((got ?? "").contains(contains), "\(note): \(got ?? "nil") does not contain \(contains)")
        }

    case "wantsAnswer":
        let got = CapsuleModel.wantsAnswer(str(input["text"]) ?? "", topKind: str(input["topKind"]), topScore: num(input["topScore"]) ?? 0)
        t.eq(got, boolOf(c["expect"]) ?? false, note)

    case "doRequest":
        let got = CapsuleModel.doRequest(str(input["text"]) ?? "")
        if c["expect"] is NSNull || c["expect"] == nil { t.ok(got == nil, "\(note): expected nil, got \(got ?? "?")") }
        else { t.eq(got, str(c["expect"]), note) }

    case "destinations":
        let cat = loadCatalog(str(input["catalog"]) ?? "default")
        var agentThreads: [VyreThread] = []
        if let tsName = str(input["agentThreads"]), let ts = threadSets[tsName] as? [String: Any] {
            let tsCat = loadCatalog(str(ts["catalog"]) ?? "default")
            let ids = Set(arr(ts["ids"]).compactMap { $0 as? String })
            let forcedAgent = str(ts["agent"])
            agentThreads = tsCat.threads.filter { ids.contains($0.id) }.map { th in var x = th; x.agent = forcedAgent; return x }
        }
        var target: VyreCandidate?
        if let tj = input["target"] as? [String: Any] { target = candidate(tj) }
        let quick = boolOf(input["quick"]) ?? false
        let d = Route.destinations(target, str(input["text"]) ?? "", cat, agentThreads: agentThreads, now: now, quick: quick)

        if let kinds = expect["kinds"] as? [String] {
            t.eq(d.options.map(kindLabel), kinds, note)
        }
        if let firstKind = str(expect["firstKind"]) {
            t.eq(d.options.first?.kind.rawValue, firstKind, note)
        }
        if let n = num(expect["optionCount"]) {
            t.eq(d.options.count, Int(n), note)
        }
        if expect.keys.contains("why") && (expect["why"] is NSNull) {
            t.ok(d.why == nil, "\(note): expected why to be nil, got \(d.why ?? "?")")
        }
        if let whyContains = str(expect["whyContains"]) {
            t.ok((d.why ?? "").contains(whyContains), "\(note): why \(d.why ?? "nil") does not contain \(whyContains)")
        }
        if let options = expect["options"] as? [[String: Any]] {
            // Checks the fields given at each index; does not require d.options to be exactly this
            // long unless the case also gives "optionCount" (some cases only pin down one row).
            t.ok(d.options.count >= options.count, "\(note): expected at least \(options.count) options, got \(d.options.count)")
            for (i, fields) in options.enumerated() where i < d.options.count {
                for (field, exp) in fields { checkOptionField(t, d.options[i], field, exp, "\(note) option[\(i)].\(field)") }
            }
        }
        if let d0 = expect["describeOptions0"] as? [String: Any], d.options.count > 0 {
            let show = Route.describe(d.options[0])
            t.eq(show.who, str(d0["who"]), "\(note) describe(options[0]).who")
            t.eq(show.where, (d0["where"] as? [String]) ?? [], "\(note) describe(options[0]).where")
        }
        if let d1 = expect["describeOptions1"] as? [String: Any], d.options.count > 1 {
            let show = Route.describe(d.options[1])
            t.eq(show.who, str(d1["who"]), "\(note) describe(options[1]).who")
            t.eq(show.where, (d1["where"] as? [String]) ?? [], "\(note) describe(options[1]).where")
        }

    default:
        t.ok(false, "route.json: unknown fn \(str(input["fn"]) ?? "?")")
    }
}

// MARK: - commands.json

private func runCommandsCase(_ t: Suite, _ c: [String: Any]) {
    let input = dict(c["input"])
    let note = str(c["note"]) ?? ""
    switch str(input["fn"]) {
    case "parse":
        let got = CLIRun.parse(str(input["text"]) ?? "")
        if c["expect"] is NSNull || c["expect"] == nil { t.ok(got == nil, "\(note): expected nil, got \(got ?? [])") }
        else { t.eq(got, arr(c["expect"]).compactMap { $0 as? String }, note) }
    case "forCapsule":
        let argv = arr(input["argv"]).compactMap { $0 as? String }
        t.eq(CLIRun.forCapsule(argv), arr(c["expect"]).compactMap { $0 as? String }, note)
    case "refused":
        let argv = arr(input["argv"]).compactMap { $0 as? String }
        let got = CLIRun.refused(argv)
        if c["expect"] is NSNull || c["expect"] == nil { t.ok(got == nil, "\(note): expected nil, got \(got ?? "?")") }
        else { t.eq(got, str(c["expect"]), note) }
    default:
        t.ok(false, "commands.json: unknown fn \(str(input["fn"]) ?? "?")")
    }
}

// MARK: - match.json

private func runMatchCase(_ t: Suite, _ c: [String: Any]) {
    let input = dict(c["input"])
    let note = str(c["note"]) ?? ""
    switch str(input["fn"]) {
    case "score":
        let synonyms = arr(input["synonyms"]).compactMap { $0 as? String }
        let got = Match.score(str(input["query"]) ?? "", str(input["label"]) ?? "", synonyms: synonyms)
        t.near(got, num(c["expect"]) ?? 0)
    case "words":
        t.eq(Match.words(str(input["label"]) ?? ""), arr(c["expect"]).compactMap { $0 as? String }, note)
    case "hits":
        let names = arr(input["names"]).compactMap { $0 as? String }
        let q = str(input["query"]) ?? ""
        let hits = names.filter { Match.score(q, $0) > 0 }.sorted { Match.score(q, $0) > Match.score(q, $1) }
        t.eq(hits, arr(c["expect"]).compactMap { $0 as? String }, note)
    default:
        t.ok(false, "match.json: unknown fn \(str(input["fn"]) ?? "?")")
    }
}

// capsule-suite: specVectorsSuite
let specVectorsSuite = Suite("spec vectors (spec/capsule)") { t in
    t.test("route.json: Route.destinations, .asksQuestion, .ownThings and AutoAsk's wantsAnswer/doRequest match every case") {
        let doc = SpecLoad.json("route.json")
        let world = dict(doc["world"])
        let catalogs = dict(doc["catalogs"])
        let threadSets = dict(doc["threadSets"])
        for c in arr(doc["cases"]) { if let cj = c as? [String: Any] { runRouteCase(t, cj, world, catalogs, threadSets) } }
    }

    t.test("commands.json: CLIRun.parse, .forCapsule and .refused match every case") {
        let doc = SpecLoad.json("commands.json")
        for c in arr(doc["cases"]) { if let cj = c as? [String: Any] { runCommandsCase(t, cj) } }
    }

    t.test("match.json: Match.score and .words match every case") {
        let doc = SpecLoad.json("match.json")
        for c in arr(doc["cases"]) { if let cj = c as? [String: Any] { runMatchCase(t, cj) } }
    }
}
