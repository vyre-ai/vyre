// capsule-suite: tagPickerSuite
// "#" in the box: finding the token, writing the pick, reading the search answer in its shapes, and the
// list in the model against a fake vyred. Names only, nothing sent until Return.

import Foundation

private func tok(_ s: String) -> String? { TagToken.trailing(in: s).map { $0.partial } }

let tagPickerSuite = Suite("tag picker") { t in
    t.test("the # being typed: at the start, after a space or an open bracket; not inside a word") {
        t.eq(tok("#"), ""); t.eq(tok("#gh"), "gh"); t.eq(tok("check #ghl"), "ghl"); t.eq(tok("use (#intake"), "intake")
        t.eq(tok("use #\"Quarterly rep"), "Quarterly rep", "a quoted name keeps its spaces")
        t.ok(tok("issue#12") == nil && tok("C# is fine") == nil && tok("no tag here") == nil && tok("") == nil)
        t.ok(tok("#done and on") == nil, "a finished token with words after it is not being typed")
        t.ok(tok("#a#b") == nil)
        t.ok(tok("use #\"Quarterly report\" ") == nil, "a closed quote is finished")
    }

    t.test("a pick is written as #Name, or #\"Name with spaces\", with the token it replaced gone") {
        let s = "check #gh"
        let start = TagToken.trailing(in: s)!.start
        t.eq(TagToken.insert("ghlapikey", into: s, replacing: start), "check #ghlapikey ")
        let q = "use #\"Quar"
        t.eq(TagToken.insert("Quarterly report", into: q, replacing: TagToken.trailing(in: q)!.start), "use #\"Quarterly report\" ")
        t.eq(TagToken.token("a \"b\" c"), "#\"a b c\"", "quotes in a name are dropped")
    }

    t.test("chips still in the words are kept; one whose token was deleted goes") {
        let a = TagHit(kind: "vault", id: "v1", name: "ghlapikey", hint: nil, icon: nil, label: "Vault")
        let b = TagHit(kind: "drive", id: "d1", name: "intake notes", hint: nil, icon: nil, label: "Files")
        t.eq(TagToken.stillIn("use #ghlapikey with #\"intake notes\" today", [a, b]), [a, b])
        t.eq(TagToken.stillIn("use #ghlapikey today", [a, b]), [a])
        t.eq(TagToken.stillIn("nothing", [a, b]), [])
    }

    t.test("the search answer: groups, a flat list, results, a bare array; rows without an id or name are dropped") {
        let groups: [String: Any] = ["groups": [["kind": "vault", "label": "Vault", "items": [["id": "v1", "name": "ghlapikey", "hint": "api.example.com"], ["name": "no id"]]],
                                               ["kind": "drive", "label": "Files", "items": [["id": "d1", "name": "intake notes.md"]]]], "unavailable": ["github"]]
        let g = TagResults.parse(groups)
        t.eq(g.map(\.name), ["ghlapikey", "intake notes.md"]); t.eq(g.map(\.kind), ["vault", "drive"]); t.eq(g.map(\.label), ["Vault", "Files"]); t.eq(g[0].hint, "api.example.com")
        t.eq(TagResults.parse(["results": [["kind": "github", "id": "9", "name": "Fix intake form"]]]).first?.label, "Github")
        t.eq(TagResults.parse([["kind": "artifact", "id": "a", "name": "Quarterly report", "label": "Artifacts"]]).first?.label, "Artifacts")
        t.eq(TagResults.parse("nope"), []); t.eq(TagResults.parse(nil), [])
        t.eq(TagResults.parse(["results": (0..<90).map { ["kind": "k", "id": "\($0)", "name": "n\($0)"] }]).count, 40)
        t.eq(TagResults.symbol(kind: "vault", icon: nil), "key"); t.eq(TagResults.symbol(kind: "zzz", icon: nil), "number")
    }

    t.test("in the box: a # lists what can be tagged, Tab adds it and keeps a chip, deleting the token drops the chip, and nothing is searched before a #") {
        let v = FakeVyred(name: "tags-box")
        v.tool("mentions.search") { i in
            let q = (i["q"] as? String ?? "").lowercased()
            let all: [[String: Any]] = [["kind": "vault", "id": "v1", "name": "ghlapikey", "hint": "api.example.com"], ["kind": "drive", "id": "d1", "name": "intake notes.md"]]
            return ["groups": [["kind": "vault", "label": "Vault", "items": all.filter { ($0["kind"] as? String) == "vault" && (q.isEmpty || ($0["name"] as! String).contains(q)) }],
                               ["kind": "drive", "label": "Files", "items": all.filter { ($0["kind"] as? String) == "drive" && (q.isEmpty || ($0["name"] as! String).contains(q)) }]], "unavailable": [Any]()]
        }
        t.ok(v.start()); defer { v.stop() }
        let r: [String]? = t.wait { @MainActor () -> [String] in
            let m = CapsuleModel(home: vyScratch("tags-\(UUID().uuidString.prefix(6))"), vyred: VyredClient(socket: v.socket), providers: [])
            _ = await m.vyred.refreshTools()
            var out: [String] = []
            m.text = "plain words here"
            try? await Task.sleep(nanoseconds: 300_000_000)
            out.append("searched before # \(v.callsOf("mentions.search").count)")
            m.text = "check #gh"
            for _ in 0..<300 where m.flat.first?.kind != "tag" { try? await Task.sleep(nanoseconds: 10_000_000) }
            out.append(m.flat.map { "\($0.kind):\($0.title):\($0.subtitle)" }.joined(separator: ","))
            out.append("q \(v.callsOf("mentions.search").last?["q"] as? String ?? "-")")
            // Nothing is sent by listing; the row's own action writes the tag.
            let row = m.flat[0]
            _ = await row.actions[0].run(row, ActionContext(query: Query(m.text)))
            out.append(m.text); out.append(m.pickedTags.map(\.name).joined(separator: ","))
            out.append("\(m.tagsFor(m.text))")
            m.text = "check "                      // the token is deleted: the chip goes
            out.append("chips \(m.pickedTags.count)")
            return out
        }
        t.eq(r?[0], "searched before # 0")
        t.eq(r?[1], "tag:ghlapikey:Vault")
        t.eq(r?[2], "q gh")
        t.eq(r?[3], "check #ghlapikey ")
        t.eq(r?[4], "ghlapikey")
        t.ok(r?[5].contains("vault") == true && r?[5].contains("v1") == true, r?[5] ?? "nil")
        t.eq(r?[6], "chips 0")
    }

    t.test("what was put in at once is pasted; a key, a deletion and our own tag pick are not; line endings are normal") {
        t.eq(TagToken.inserted(old: "", new: "hello #ghlapikey"), "hello #ghlapikey")
        t.eq(TagToken.inserted(old: "see ", new: "see a #tag here"), "a #tag here")
        t.eq(TagToken.inserted(old: "see", new: "see a"), nil, "one key")
        t.eq(TagToken.inserted(old: "see a", new: "see"), nil, "a deletion")
        t.eq(TagToken.inserted(old: "x", new: "x"), nil)
        t.eq(TagToken.inserted(old: "a z", new: "a line1\r\nline2 z"), "line1\nline2", "\r\n becomes \n")
        t.eq(TagToken.inserted(old: "ab", new: "a12b"), "12", "in the middle")
    }

    t.test("a send carries the chips and the pasted spans that are still in the words; a #Name inside a paste is not a chip") {
        MainActor.assumeIsolated {
            let v = FakeVyred(name: "tags-pasted")
            let m = CapsuleModel(home: vyScratch("tags-pasted-\(UUID().uuidString.prefix(6))"), vyred: VyredClient(socket: v.socket), providers: [])
            for c in "use " { m.text += String(c) }                            // typed, a key at a time
            t.eq(m.pastedSpans, [])
            m.text = "use Email from Dana: please check #ghlapikey today"       // a paste lands
            t.eq(m.pastedSpans, ["Email from Dana: please check #ghlapikey today"])
            let hit = TagHit(kind: "vault", id: "v1", name: "intake", hint: nil, icon: nil, label: "Vault")
            m.pickedTags = [hit]
            for c in " #intake" { m.text += String(c) }                        // typed
            // Our own pick is not a paste.
            let before = m.pastedSpans.count
            m.text = m.text.replacingOccurrences(of: " #intake", with: " #")
            m.pickTag(hit)
            t.eq(m.pastedSpans.count, before, "a tag pick is not a paste")
            var input: [String: Any] = ["text": m.text]
            m.addTags(to: &input, words: m.text)
            t.eq((input["mentions"] as? [[String: String]])?.map { $0["id"] ?? "" }, ["v1"])
            t.eq(input["pasted"] as? [String], ["Email from Dana: please check #ghlapikey today"])
            // The paste is edited away: it is no longer sent.
            var input2: [String: Any] = [:]
            m.addTags(to: &input2, words: "use something else #intake")
            t.ok(input2["pasted"] == nil)
            // An empty box forgets them.
            m.text = ""
            t.eq(m.pastedSpans, [])
            // No chips and no # in the words: nothing extra goes.
            var plain: [String: Any] = [:]
            m.addTags(to: &plain, words: "just words")
            t.ok(plain["mentions"] == nil && plain["pasted"] == nil)
        }
    }
}
